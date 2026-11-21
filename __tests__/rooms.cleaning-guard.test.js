/**
 * Regression: a room that still needs cleaning can never become AVAILABLE by
 * passing through MAINTENANCE (the DIRTY → MAINTENANCE → AVAILABLE loophole).
 *
 *   - the cleaning requirement (rooms.cleaning_required) survives MAINTENANCE;
 *   - an open cleaning task blocks AVAILABLE on its own;
 *   - only a verified housekeeping completion or the front desk's "Mark clean"
 *     clears it, and doing so during maintenance leaves the room MAINTENANCE;
 *   - open tasks are never closed automatically;
 *   - a clean room still enters and leaves maintenance normally;
 *   - the migration backfills the flag for existing rooms.
 *
 * Real MySQL (test database), real HTTP; Housekeeping is a simulated signed client.
 */
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS } from "./helpers/harness.js";
import { Room, RoomStatusLog, HousekeepingTask, IntegrationEvent, sequelize, upgradeSchema } from "../models/index.js";
import { transition } from "../services/roomStatusService.js";

let app;
let admin;
let desk;
let housekeeping;

const SUITES = ["501", "502", "503", "504", "505", "506", "507", "508"];
const room = (n) => Room.findOne({ where: { roomNumber: n } });
const setStatus = async (n, status) => admin.patch(`/admin/rooms/${(await room(n)).id}`, { status });
const completed = (extra) => ({ status: "COMPLETED", completed_by: "EMP-777", completed_at: new Date().toISOString(), ...extra });

/** A room waiting for housekeeping, reached through valid lifecycle steps (AVAILABLE → MAINTENANCE → DIRTY). */
async function makeDirty(n) {
  expect((await setStatus(n, "MAINTENANCE")).data.status).toBe("MAINTENANCE");
  expect((await setStatus(n, "DIRTY")).data.status).toBe("DIRTY");
  expect((await room(n)).cleaningRequired).toBe(true);
}

async function expectNeedsCleaning(n) {
  const res = await setStatus(n, "AVAILABLE");
  expect(res.status).toBe(409);
  expect(res.error.code).toBe("ROOM_NEEDS_CLEANING");
  expect(res.error.details).toMatchObject({ room_status: "MAINTENANCE", cleaning_required: true });
  expect((await room(n)).status).toBe("MAINTENANCE");
  return res;
}

beforeAll(async () => {
  await resetDatabase();
  await Room.bulkCreate(SUITES.map((roomNumber) => ({ roomNumber, roomType: "Suite", capacity: 2, nightlyRate: 4000 })));
  app = await startApp();
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  housekeeping = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY, { signingSecret: process.env.HOUSEKEEPING_INBOUND_SECRET });
});
afterAll(() => app?.close());

describe("1. DIRTY → MAINTENANCE → AVAILABLE is rejected", () => {
  test("the administrator cannot end maintenance as AVAILABLE; the room stays MAINTENANCE and nothing is logged", async () => {
    await makeDirty("501");
    expect((await setStatus("501", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    expect((await room("501")).cleaningRequired).toBe(true); // preserved through maintenance

    const res = await expectNeedsCleaning("501");
    expect(res.error.message).toMatch(/Needs cleaning/);
    const r = await room("501");
    expect(await RoomStatusLog.count({ where: { roomId: r.id, toStatus: ["AVAILABLE", "RESERVED"] } })).toBe(0);
  });

  test("the rule is enforced by the room status service itself, not only by the admin screen", async () => {
    const r = await room("501");
    await expect(
      sequelize.transaction((t) => transition(r.id, "AVAILABLE", { reason: "MAINTENANCE_ENDED", source: "ADMIN" }, t))
    ).rejects.toMatchObject({ status: 409, code: "ROOM_NEEDS_CLEANING" });
    await expect(
      sequelize.transaction((t) => transition(r.id, "RESERVED", { reason: "MAINTENANCE_ENDED", source: "ADMIN" }, t))
    ).rejects.toMatchObject({ status: 409, code: "ROOM_NEEDS_CLEANING" });
    expect((await room("501")).status).toBe("MAINTENANCE");
  });

  test("CLEANING → MAINTENANCE → AVAILABLE is rejected too", async () => {
    await makeDirty("502");
    expect((await housekeeping.post("/cleaning-status", { status: "IN_PROGRESS", external_task_id: "RC-502", room_number: "502", started_by: "EMP-777" })).status).toBe(200);
    expect((await room("502")).status).toBe("CLEANING");
    expect((await setStatus("502", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    await expectNeedsCleaning("502");
  });

  test("a DIRTY row from before the migration (flag never set) gets the requirement when it enters MAINTENANCE", async () => {
    await Room.update({ status: "DIRTY", cleaningRequired: false }, { where: { roomNumber: "503" } });
    expect((await setStatus("503", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    expect((await room("503")).cleaningRequired).toBe(true);
    await expectNeedsCleaning("503");
  });
});

describe("2. DIRTY → MAINTENANCE → cleaning completed → AVAILABLE is allowed", () => {
  test("a verified completion during maintenance is recorded, the room stays MAINTENANCE, then it can be made AVAILABLE", async () => {
    await makeDirty("504");
    expect((await setStatus("504", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    await expectNeedsCleaning("504");

    const done = await housekeeping.post("/cleaning-status", completed({ external_task_id: "RC-504", room_number: "504" }));
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ cleaning_status: "COMPLETED", task_status: "COMPLETED", room_status: "MAINTENANCE", previous_room_status: "MAINTENANCE" });
    const r = await room("504");
    expect(r).toMatchObject({ status: "MAINTENANCE", cleaningRequired: false });
    expect(r.lastCleanedAt).not.toBeNull();
    const cleaned = await IntegrationEvent.findOne({ where: { eventType: "RoomCleaned", aggregateId: r.id }, order: [["id", "DESC"]] });
    expect(cleaned.payload).toMatchObject({ room_number: "504", room_status: "MAINTENANCE", external_task_id: "RC-504", origin: "HOUSEKEEPING" });

    const back = await setStatus("504", "AVAILABLE");
    expect(back.status).toBe(200);
    expect(back.data.status).toBe("AVAILABLE");
  });

  test("the full PENDING → IN_PROGRESS → COMPLETED sequence during maintenance never takes the room out of MAINTENANCE", async () => {
    await makeDirty("505");
    expect((await setStatus("505", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    expect((await housekeeping.post("/cleaning-status", { status: "PENDING", external_task_id: "RC-505", room_number: "505" })).status).toBe(201);
    const started = await housekeeping.post("/cleaning-status", { status: "IN_PROGRESS", external_task_id: "RC-505", room_number: "505", started_by: "EMP-777" });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ task_status: "IN_PROGRESS", room_status: "MAINTENANCE" });
    await expectNeedsCleaning("505"); // started is not finished
    expect((await housekeeping.post("/cleaning-status", completed({ external_task_id: "RC-505", room_number: "505" }))).data.room_status).toBe("MAINTENANCE");
    const r = await room("505");
    expect(await RoomStatusLog.count({ where: { roomId: r.id, toStatus: "CLEANING" } })).toBe(0);
    expect((await setStatus("505", "AVAILABLE")).data.status).toBe("AVAILABLE");
  });

  test("the front desk's explicit 'Mark clean' during maintenance also clears the requirement (room stays MAINTENANCE)", async () => {
    await makeDirty("506");
    expect((await setStatus("506", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    const r = await room("506");
    const marked = await desk.post(`/rooms/${r.id}/clean`);
    expect(marked.status).toBe(200);
    expect(marked.data).toMatchObject({ status: "MAINTENANCE", cleaningRequired: false });
    expect((await setStatus("506", "AVAILABLE")).data.status).toBe("AVAILABLE");
  });

  test("returning the room to service as DIRTY and cleaning it normally still works", async () => {
    expect((await setStatus("501", "DIRTY")).data.status).toBe("DIRTY");
    const done = await housekeeping.post("/cleaning-completed", completed({ external_task_id: "RC-501", room_number: "501" }));
    expect(done.status).toBe(200);
    expect(done.data.room_status).toBe("AVAILABLE");
    expect((await room("501")).cleaningRequired).toBe(false);
  });
});

describe("3. A room with an open cleaning task cannot become available", () => {
  test("an open task blocks ending maintenance, even when the cleaning_required flag is clear; the task is not closed", async () => {
    await makeDirty("507");
    expect((await housekeeping.post("/cleaning-status", { status: "PENDING", external_task_id: "RC-507", room_number: "507" })).status).toBe(201);
    expect((await setStatus("507", "MAINTENANCE")).data.status).toBe("MAINTENANCE");

    const res = await expectNeedsCleaning("507");
    expect(res.error.details.open_task).toEqual({ external_task_id: "RC-507", task_status: "OPEN" });

    // A row whose flag is clear (e.g. inconsistent legacy data): the open task alone still blocks it.
    await Room.update({ cleaningRequired: false }, { where: { roomNumber: "507" } });
    const again = await setStatus("507", "AVAILABLE");
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("ROOM_NEEDS_CLEANING");
    expect(again.error.details.open_task.external_task_id).toBe("RC-507");
    const r = await room("507");
    await expect(
      sequelize.transaction((t) => transition(r.id, "AVAILABLE", { reason: "MAINTENANCE_ENDED", source: "ADMIN" }, t))
    ).rejects.toMatchObject({ code: "ROOM_NEEDS_CLEANING" });

    // Nothing closed the task behind housekeeping's back.
    expect((await HousekeepingTask.findOne({ where: { externalTaskId: "RC-507" } })).status).toBe("OPEN");
  });

  test("once housekeeping completes that task, the room can be made available", async () => {
    expect((await housekeeping.post("/cleaning-status", completed({ external_task_id: "RC-507", room_number: "507" }))).status).toBe(200);
    expect((await HousekeepingTask.findOne({ where: { externalTaskId: "RC-507" } })).status).toBe("COMPLETED");
    expect((await setStatus("507", "AVAILABLE")).data.status).toBe("AVAILABLE");
  });
});

describe("4. A clean room still goes MAINTENANCE → AVAILABLE normally", () => {
  test("AVAILABLE → MAINTENANCE → AVAILABLE works and is logged as maintenance ended", async () => {
    expect((await setStatus("508", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    expect((await room("508")).cleaningRequired).toBe(false);
    const back = await setStatus("508", "AVAILABLE");
    expect(back.status).toBe(200);
    expect(back.data.status).toBe("AVAILABLE");
    const r = await room("508");
    const last = await RoomStatusLog.findOne({ where: { roomId: r.id }, order: [["id", "DESC"]] });
    expect(last).toMatchObject({ fromStatus: "MAINTENANCE", toStatus: "AVAILABLE", reason: "MAINTENANCE_ENDED", source: "ADMIN" });
  });

  test("a room that was cleaned before maintenance leaves maintenance as AVAILABLE", async () => {
    // 501 was dirtied and then cleaned by housekeeping above.
    expect((await setStatus("501", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    expect((await setStatus("501", "AVAILABLE")).data.status).toBe("AVAILABLE");
  });

  test("cleaning reports and 'Mark clean' are still refused for a clean room under maintenance", async () => {
    expect((await setStatus("508", "MAINTENANCE")).data.status).toBe("MAINTENANCE");
    const hk = await housekeeping.post("/cleaning-status", completed({ external_task_id: "RC-508", room_number: "508" }));
    expect(hk.status).toBe(409);
    expect(hk.error.code).toBe("ROOM_NOT_AWAITING_CLEANING");
    const marked = await desk.post(`/rooms/${(await room("508")).id}/clean`);
    expect(marked.status).toBe(409);
    expect(marked.error.code).toBe("ALREADY_CLEAN");
    expect((await setStatus("508", "AVAILABLE")).data.status).toBe("AVAILABLE");
  });
});

describe("Migration: rooms.cleaning_required is backfilled", () => {
  test("existing rooms that still need cleaning get the flag; clean rooms do not", async () => {
    await makeDirty("102");
    expect((await setStatus("102", "MAINTENANCE")).data.status).toBe("MAINTENANCE"); // latest maintenance entry: from DIRTY
    expect((await setStatus("204", "MAINTENANCE")).data.status).toBe("MAINTENANCE"); // clean room under maintenance
    await Room.update({ status: "DIRTY" }, { where: { roomNumber: "301" } });
    await makeDirty("101");
    expect((await housekeeping.post("/cleaning-tasks", { external_task_id: "RC-101", room_number: "101" })).status).toBe(201);

    await sequelize.query("ALTER TABLE rooms DROP COLUMN cleaning_required");
    const applied = await upgradeSchema();
    expect(applied).toContain("rooms.cleaning_required");

    const flag = async (n) => (await room(n)).cleaningRequired;
    expect(await flag("102")).toBe(true); // MAINTENANCE entered from DIRTY
    expect(await flag("204")).toBe(false); // MAINTENANCE entered from AVAILABLE
    expect(await flag("301")).toBe(true); // DIRTY
    expect(await flag("101")).toBe(true); // DIRTY with an open task
    expect(await flag("508")).toBe(false); // clean, AVAILABLE
    expect(await upgradeSchema()).toEqual([]);
    await expectNeedsCleaning("102");
  });
});
