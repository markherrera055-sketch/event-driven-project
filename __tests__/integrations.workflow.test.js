/**
 * End-to-end hotel workflow across the five systems, with every external
 * system simulated (no other member's application needs to run):
 *
 *   Booking (M1) books → Frontdesk (M2) checks in → POS (M4) charges the room →
 *   Frontdesk bills, takes payment, checks out → room DIRTY + RoomVacated to
 *   Housekeeping (M3) → cleaning started / completed → room AVAILABLE →
 *   HR (M5) verifies the housekeeping job log against the PMS record.
 *
 * Also: guest folio and final bill arithmetic, the room status state machine,
 * housekeeping edge cases, transactional event publishing, webhook retries
 * and duplicate event delivery.
 */
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, newKey, startReceiver } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { Room, RoomStatusLog, HousekeepingTask, IntegrationEvent, IntegrationOutbox, sequelize } from "../models/index.js";
import { canTransition, transition, ROOM_TRANSITIONS } from "../services/roomStatusService.js";
import { today, addDays } from "../utils/dates.js";

let app;
let desk;
let admin;
let booking;
let pos;
let housekeeping;
let hr;
let hooks;
const D0 = today();
const D = (n) => addDays(D0, n);
const ctx = {};
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const room = async (n) => Room.findOne({ where: { roomNumber: n } });
const roomStatus = async (n) => (await room(n)).status;

async function verifyAndCheckIn(reservationId, name) {
  await desk.post("/verifications", { reservationId, idType: "NATIONAL_ID", idNumberLast4: "7788", nameOnId: name, expiryDate: D(3650), photoMatches: true });
  return desk.post("/check-ins", { reservationId });
}

const book = (id, roomType, from, to, extra = {}) =>
  booking.post("/reservations", {
    external_reservation_id: id,
    guest: { first_name: "Guest", last_name: id.replace(/[^A-Za-z]/g, ""), email: `${id.toLowerCase()}@example.com` },
    room_type: roomType,
    check_in_date: from,
    check_out_date: to,
    number_of_guests: 1,
    ...extra,
  });

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  booking = new IntegrationClient(app.base, "booking", process.env.BOOKING_API_KEY);
  pos = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY);
  housekeeping = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY, { signingSecret: process.env.HOUSEKEEPING_INBOUND_SECRET });
  hr = new IntegrationClient(app.base, "hr", process.env.HR_API_KEY);
  hooks = {
    BOOKING: await startReceiver("BOOKING", process.env.BOOKING_WEBHOOK_SECRET),
    POS: await startReceiver("POS", process.env.POS_WEBHOOK_SECRET),
    HOUSEKEEPING: await startReceiver("HOUSEKEEPING", process.env.HOUSEKEEPING_WEBHOOK_SECRET),
  };
});
afterAll(async () => {
  for (const h of Object.values(hooks || {})) await h.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("End-to-end: booking → stay → POS → checkout → housekeeping → HR", () => {
  test("M1 books a Deluxe room: room 204 assigned and RESERVED", async () => {
    const res = await book("BOOK-E2E", "Deluxe", D0, D(1), { guest: { first_name: "Maria", last_name: "Santos", email: "maria@example.com" } });
    expect(res.status).toBe(201);
    expect(res.data.room).toMatchObject({ room_number: "204", status: "RESERVED" });
    ctx.reservation = res.data;
  });

  test("M2 checks the guest in: reservation CHECKED_IN, room OCCUPIED, check-in time recorded", async () => {
    const res = await verifyAndCheckIn(ctx.reservation.reservation_id, "Maria Santos");
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ status: "IN_HOUSE", reservation: { status: "CHECKED_IN" } });
    expect(new Date(res.data.checkInAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await roomStatus("204")).toBe("OCCUPIED");
    ctx.stayId = res.data.id;
  });

  test("M4 posts a restaurant charge and a minibar charge to the room", async () => {
    const base = { room_number: "204", reservation_id: ctx.reservation.reservation_id, guest_name: "Maria Santos", currency: "PHP", transaction_date: new Date().toISOString() };
    const food = await pos.post("/room-charges", { ...base, external_transaction_id: "POS-E2E-1", amount: 850, description: "Restaurant Order", items: [{ name: "Chicken Adobo", quantity: 2, unit_price: 250 }, { name: "Iced Tea", quantity: 2, unit_price: 175 }] });
    const minibar = await pos.post("/room-charges", { ...base, external_transaction_id: "POS-E2E-2", amount: 300, category: "MINIBAR", description: "Minibar" });
    expect([food.status, minibar.status]).toEqual([201, 201]);
  });

  test("guest folio before the bill: room nights accrued, restaurant and other charges, full balance", async () => {
    const folio = (await desk.get(`/stays/${ctx.stayId}/folio`)).data;
    expect(folio.room).toMatchObject({ nights: 1, nightlyRate: 3500, amount: 3500, basis: "ACCRUED_TO_DATE" });
    expect(folio.totals).toEqual({ roomCharges: 3500, restaurantCharges: 850, otherCharges: 300, adjustments: 0, totalCharges: 4650, payments: 0, balance: 4650 });
    expect(folio.lines.map((l) => l.type)).toEqual(expect.arrayContaining(["ROOM", "RESTAURANT", "OTHER_CHARGE"]));
    expect(folio.folioOpen).toBe(true);
  });

  test("final bill = room + every folio charge + adjustments; folio and bill agree", async () => {
    const stay = (await desk.post("/bills", { stayId: ctx.stayId })).data;
    ctx.billId = stay.bill.id;
    expect(stay.bill.totals).toEqual({ roomCharge: 3500, chargesTotal: 1150, adjustmentsTotal: 0, totalDue: 4650 });
    await desk.post(`/bills/${ctx.billId}/adjustments`, { amount: -150, reason: "Loyalty discount" });
    const totals = (await desk.get(`/bills/${ctx.billId}/totals`)).data;
    expect(totals.totalDue).toBe(4500);
    const folio = (await desk.get(`/stays/${ctx.stayId}/folio`)).data;
    expect(folio.room.basis).toBe("BILLED");
    expect(folio.totals).toMatchObject({ adjustments: -150, totalCharges: 4500, balance: 4500 });
  });

  test("payments: a declined attempt is listed but not counted; the successful one clears the balance", async () => {
    await desk.post(`/bills/${ctx.billId}/confirm`);
    expect((await desk.post("/payments", { billId: ctx.billId, method: "CARD", amount: 4500, paymentToken: "tok_decline_x" })).data.status).toBe("FAILED");
    expect((await desk.post("/payments", { billId: ctx.billId, method: "CASH", amount: 4500 })).data.status).toBe("SUCCESSFUL");
    const folio = (await desk.get(`/stays/${ctx.stayId}/folio`)).data;
    expect(folio.failedPayments).toHaveLength(1);
    expect(folio.totals).toMatchObject({ totalCharges: 4500, payments: 4500, balance: 0 });
    expect(folio.folioOpen).toBe(false);
  });

  test("M2 checks out: reservation CHECKED_OUT, checkout time recorded, room DIRTY — not AVAILABLE", async () => {
    const res = await desk.post("/checkouts", { stayId: ctx.stayId });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ status: "CHECKED_OUT", reservation: { status: "CHECKED_OUT" } });
    expect(res.data.checkOutAt).toBeTruthy();
    expect(await roomStatus("204")).toBe("DIRTY");
  });

  test("webhooks: RoomVacated to Housekeeping, GuestCheckedOut (with final folio) to Booking and POS — all signed", async () => {
    await processOutbox();
    const [vacated] = hooks.HOUSEKEEPING.events("RoomVacated");
    expect(vacated).toMatchObject({
      event: "RoomVacated",
      event_id: expect.stringMatching(/^EVT-\d{6}$/),
      reservation_id: ctx.reservation.reservation_id,
      stay_id: ctx.stayId,
      room_id: (await room("204")).id,
      room_number: "204",
      guest_id: ctx.reservation.guest_id,
      reason: "CHECKOUT",
    });
    expect(new Date(vacated.checkout_time).getTime()).toBeGreaterThan(Date.now() - 60_000);
    ctx.vacatedEventId = vacated.event_id;
    expect(hooks.HOUSEKEEPING.events("RoomStatusChanged").some((e) => e.room_number === "204" && e.from_status === "OCCUPIED" && e.to_status === "DIRTY")).toBe(true);

    const [out] = hooks.BOOKING.events("GuestCheckedOut");
    expect(out).toMatchObject({ external_reservation_id: "BOOK-E2E", status: "CHECKED_OUT", folio: { room_charges: 3500, restaurant_charges: 850, other_charges: 300, adjustments: -150, total_charges: 4500, payments: 4500, balance: 0, currency: "PHP" } });
    expect(hooks.POS.events("GuestCheckedOut")[0].event_id).toBe(out.event_id);
    for (const h of Object.values(hooks)) expect(h.received.every((r) => r.signatureValid)).toBe(true);
  });

  test("M3 acknowledges its cleaning task (room stays DIRTY), then starts cleaning (DIRTY → CLEANING)", async () => {
    const task = await housekeeping.post("/cleaning-tasks", { external_task_id: "HK-10001", room_number: "204", event_id: ctx.vacatedEventId });
    expect(task.status).toBe(201);
    expect(task.data).toMatchObject({ task_status: "OPEN", room_status: "DIRTY", stay_id: ctx.stayId, source_event_id: ctx.vacatedEventId });

    const started = await housekeeping.post("/cleaning-started", { external_task_id: "HK-10001", room_number: "204", started_by: "EMP-001", started_at: minutesAgo(60) });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ task_status: "IN_PROGRESS", room_status: "CLEANING", started_by: "EMP-001" });
    expect(await roomStatus("204")).toBe("CLEANING");
  });

  test("M3 reports cleaning completed: room AVAILABLE, completion and task reference recorded, RoomCleaned published", async () => {
    const completedAt = new Date().toISOString();
    ctx.completion = { external_task_id: "HK-10001", room_id: (await room("204")).id, room_number: "204", status: "COMPLETED", completed_by: "EMP-001", completed_at: completedAt, remarks: "Room cleaned and inspected" };
    ctx.completionKey = newKey("hk");
    const res = await housekeeping.post("/cleaning-completed", ctx.completion, { key: ctx.completionKey });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ external_task_id: "HK-10001", task_status: "COMPLETED", room_status: "AVAILABLE", previous_room_status: "CLEANING", completed_by: "EMP-001", remarks: "Room cleaned and inspected" });

    const r204 = await room("204");
    expect(r204.status).toBe("AVAILABLE");
    expect(Math.abs(new Date(r204.lastCleanedAt) - new Date(completedAt))).toBeLessThan(1000);
    const log = await RoomStatusLog.findOne({ where: { roomId: r204.id, toStatus: "AVAILABLE" }, order: [["id", "DESC"]] });
    expect(log).toMatchObject({ fromStatus: "CLEANING", source: "HOUSEKEEPING", reason: "CLEANING_COMPLETED", reference: "HK-10001" });

    await processOutbox();
    expect(hooks.HOUSEKEEPING.events("RoomCleaned")).toEqual([expect.objectContaining({ room_number: "204", room_status: "AVAILABLE", external_task_id: "HK-10001", completed_by: "EMP-001", origin: "HOUSEKEEPING" })]);
  });

  test("duplicate completion: a network retry replays the response; a re-send under a new key → 409", async () => {
    const replay = await housekeeping.post("/cleaning-completed", ctx.completion, { key: ctx.completionKey });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const dup = await housekeeping.post("/cleaning-completed", ctx.completion);
    expect(dup.status).toBe(409);
    expect(dup.error.code).toBe("DUPLICATE_CLEANING_COMPLETION");
    expect(await RoomStatusLog.count({ where: { reference: "HK-10001", toStatus: "AVAILABLE" } })).toBe(1);
  });

  test("the room's full status history is audited", async () => {
    const history = (await desk.get(`/rooms/${(await room("204")).id}/status-history`)).data.reverse();
    expect(history.map((h) => `${h.fromStatus}→${h.toStatus}`)).toEqual(["AVAILABLE→RESERVED", "RESERVED→OCCUPIED", "OCCUPIED→DIRTY", "DIRTY→CLEANING", "CLEANING→AVAILABLE"]);
    expect(history.map((h) => h.source)).toEqual(["BOOKING", "FRONT_DESK", "FRONT_DESK", "HOUSEKEEPING", "HOUSEKEEPING"]);
  });

  test("M5 (HR) verifies a housekeeping job log against the PMS record", async () => {
    // The log Housekeeping sends DIRECTLY to HR (the PMS does not relay it).
    const hrLog = { external_log_id: "HKLOG-10001", employee_id: "EMP-001", employee_name: "Jane Smith", task_id: "HK-10001", room_number: "204", task_type: "ROOM_CLEANING", started_at: minutesAgo(60), completed_at: ctx.completion.completed_at, total_minutes: 60, status: "COMPLETED" };

    const list = await hr.get(`/housekeeping-tasks?from=${D0}&to=${D0}`);
    expect(list.status).toBe(200);
    expect(list.data.map((t) => t.external_task_id)).toContain("HK-10001");

    const record = (await hr.get(`/housekeeping-tasks/${hrLog.task_id}`)).data;
    expect(record).toMatchObject({ task_status: "COMPLETED", room_number: "204", started_by: "EMP-001", completed_by: "EMP-001", duration_minutes: 60 });

    // HR-side check (its own business rule): the log must match what the PMS accepted.
    const matches = (log, pms) => pms.task_status === "COMPLETED" && pms.room_number === log.room_number && pms.completed_by === log.employee_id && Math.abs(pms.duration_minutes - log.total_minutes) <= 5;
    expect(matches(hrLog, record)).toBe(true);
    expect(matches({ ...hrLog, room_number: "301" }, record)).toBe(false);
    expect(matches({ ...hrLog, total_minutes: 180 }, record)).toBe(false);

    const byEmployee = await hr.get(`/housekeeping-tasks?from=${D0}&to=${D0}&employee_id=EMP-999`);
    expect(byEmployee.data).toEqual([]);
    const unknown = await hr.get("/housekeeping-tasks/HK-NOPE");
    expect(unknown.status).toBe(404);
    expect(unknown.error.code).toBe("TASK_NOT_FOUND");
    expect((await hr.get(`/housekeeping-tasks?from=${D0}&to=${D(60)}`)).status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Room status lifecycle rules", () => {
  test("the transition table allows exactly the documented changes", () => {
    const allowed = Object.entries(ROOM_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}→${to}`));
    expect(allowed.sort()).toEqual(
      [
        "AVAILABLE→RESERVED", "AVAILABLE→OCCUPIED", "AVAILABLE→MAINTENANCE",
        "RESERVED→AVAILABLE", "RESERVED→OCCUPIED", "RESERVED→MAINTENANCE",
        "OCCUPIED→DIRTY",
        "DIRTY→CLEANING", "DIRTY→MAINTENANCE",
        "CLEANING→AVAILABLE", "CLEANING→RESERVED", "CLEANING→DIRTY", "CLEANING→MAINTENANCE",
        "MAINTENANCE→AVAILABLE", "MAINTENANCE→RESERVED", "MAINTENANCE→DIRTY",
      ].sort()
    );
    for (const [from, to] of [["OCCUPIED", "AVAILABLE"], ["DIRTY", "AVAILABLE"], ["DIRTY", "OCCUPIED"], ["CLEANING", "OCCUPIED"], ["MAINTENANCE", "OCCUPIED"], ["OCCUPIED", "MAINTENANCE"]]) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  test("the service refuses an invalid transition and leaves the room unchanged", async () => {
    const r101 = await room("101");
    await expect(sequelize.transaction((t) => transition(r101.id, "DIRTY", { reason: "TEST", source: "SYSTEM" }, t))).rejects.toMatchObject({
      status: 409,
      code: "INVALID_ROOM_STATUS_TRANSITION",
    });
    expect(await roomStatus("101")).toBe("AVAILABLE");
  });

  test("check-in into a DIRTY or CLEANING room is refused (ROOM_NOT_READY), and nothing is published", async () => {
    const res = (await book("BOOK-DIRTY", "Family", D0, D(1))).data;
    expect(res.room.room_number).toBe("301");
    const eventsBefore = await IntegrationEvent.count();
    for (const status of ["DIRTY", "CLEANING"]) {
      await Room.update({ status }, { where: { roomNumber: "301" } });
      const attempt = await verifyAndCheckIn(res.reservation_id, "Guest BOOKDIRTY");
      expect(attempt.status).toBe(409);
      expect(attempt.error.code).toBe("ROOM_NOT_READY");
    }
    // The failed check-ins were rolled back: no GuestCheckedIn / RoomStatusChanged events exist for them.
    expect(await IntegrationEvent.count({ where: { eventType: "GuestCheckedIn" } })).toBe(1);
    expect(await IntegrationEvent.count()).toBe(eventsBefore);
    ctx.familyBooking = res;
  });

  test("administrators cannot skip housekeeping or put an occupied room under maintenance", async () => {
    const r301 = await room("301"); // CLEANING (from the previous test)
    const skip = await admin.patch(`/admin/rooms/${r301.id}`, { status: "AVAILABLE" });
    expect(skip.status).toBe(409);
    expect(skip.error.code).toBe("ROOM_NEEDS_CLEANING");

    const r101 = await room("101");
    const dirtyFromAvailable = await admin.patch(`/admin/rooms/${r101.id}`, { status: "DIRTY" });
    expect(dirtyFromAvailable.status).toBe(409);
    expect(dirtyFromAvailable.error.code).toBe("INVALID_ROOM_STATUS_TRANSITION");

    const occupied = (await book("BOOK-OCC", "Standard", D0, D(1))).data;
    expect((await verifyAndCheckIn(occupied.reservation_id, "Guest BOOKOCC")).status).toBe(201);
    const maint = await admin.patch(`/admin/rooms/${occupied.room.room_id}`, { status: "MAINTENANCE" });
    expect(maint.status).toBe(409);
    expect(maint.error.code).toBe("ROOM_OCCUPIED");
    ctx.occupiedRoom = occupied.room;
  });

  test("maintenance: DIRTY → MAINTENANCE → back in service as DIRTY or ready", async () => {
    const r102 = await room("102");
    expect(r102.status).toBe("AVAILABLE");
    expect((await admin.patch(`/admin/rooms/${r102.id}`, { status: "MAINTENANCE" })).data.status).toBe("MAINTENANCE");
    expect((await admin.patch(`/admin/rooms/${r102.id}`, { status: "DIRTY" })).data.status).toBe("DIRTY");
    expect((await admin.patch(`/admin/rooms/${r102.id}`, { status: "MAINTENANCE" })).data.status).toBe("MAINTENANCE");
    expect((await admin.patch(`/admin/rooms/${r102.id}`, { status: "AVAILABLE" })).data.status).toBe("AVAILABLE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Housekeeping edge cases", () => {
  const completion = (extra) => ({ status: "COMPLETED", completed_by: "EMP-002", completed_at: new Date().toISOString(), ...extra });

  test("cleaning cannot start or complete on an occupied room", async () => {
    const started = await housekeeping.post("/cleaning-started", { external_task_id: "HK-OCC-1", room_number: ctx.occupiedRoom.room_number, started_by: "EMP-002" });
    expect(started.status).toBe(409);
    expect(started.error.code).toBe("ROOM_NOT_AWAITING_CLEANING");
    const done = await housekeeping.post("/cleaning-completed", completion({ external_task_id: "HK-OCC-2", room_number: ctx.occupiedRoom.room_number }));
    expect(done.status).toBe(409);
    expect(await HousekeepingTask.count({ where: { externalTaskId: ["HK-OCC-1", "HK-OCC-2"] } })).toBe(0);
  });

  test("room_id and room_number must agree; unknown rooms → 404; invalid payload → 422", async () => {
    const r101 = await room("101");
    const mismatch = await housekeeping.post("/cleaning-completed", completion({ external_task_id: "HK-MM", room_id: r101.id, room_number: "204" }));
    expect(mismatch.status).toBe(409);
    expect(mismatch.error.code).toBe("ROOM_MISMATCH");
    const unknown = await housekeeping.post("/cleaning-completed", completion({ external_task_id: "HK-404", room_number: "999" }));
    expect(unknown.status).toBe(404);
    const invalid = await housekeeping.post("/cleaning-completed", { external_task_id: "HK-BAD", room_number: "101", status: "DONE" });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.error.details)).toEqual(expect.arrayContaining(["status", "completed_by", "completed_at"]));
  });

  test("completion reported without a start: DIRTY → CLEANING → ready, both steps logged", async () => {
    const r301 = await room("301");
    await Room.update({ status: "DIRTY" }, { where: { id: r301.id } });
    const res = await housekeeping.post("/cleaning-completed", completion({ external_task_id: "HK-301", room_number: "301" }));
    expect(res.status).toBe(200);
    expect(res.data.previous_room_status).toBe("DIRTY");
    // A confirmed reservation is assigned to 301 (BOOK-DIRTY), so the clean room is RESERVED.
    expect(res.data.room_status).toBe("RESERVED");
    const steps = await RoomStatusLog.findAll({ where: { roomId: r301.id, reference: "HK-301" }, order: [["id", "ASC"]] });
    expect(steps.map((s) => `${s.fromStatus}→${s.toStatus}`)).toEqual(["DIRTY→CLEANING", "CLEANING→RESERVED"]);
  });

  test("a task id cannot be reused for another room", async () => {
    await Room.update({ status: "DIRTY" }, { where: { roomNumber: "102" } });
    const res = await housekeeping.post("/cleaning-started", { external_task_id: "HK-10001", room_number: "102", started_by: "EMP-002" });
    expect(res.status).toBe(409);
    expect(["TASK_ROOM_MISMATCH", "TASK_ALREADY_STARTED"]).toContain(res.error.code);
  });

  test("when the front desk marks a room clean first, the open task is superseded and a late completion is refused", async () => {
    expect((await housekeeping.post("/cleaning-tasks", { external_task_id: "HK-102", room_number: "102" })).status).toBe(201);
    const manual = await desk.post(`/rooms/${(await room("102")).id}/clean`);
    expect(manual.data.status).toBe("AVAILABLE");
    expect((await HousekeepingTask.findOne({ where: { externalTaskId: "HK-102" } })).status).toBe("SUPERSEDED");
    const late = await housekeeping.post("/cleaning-completed", completion({ external_task_id: "HK-102", room_number: "102" }));
    expect(late.status).toBe(409);
    expect(late.error.code).toBe("TASK_SUPERSEDED");
    await processOutbox();
    expect(hooks.HOUSEKEEPING.events("RoomCleaned").some((e) => e.room_number === "102" && e.origin === "FRONT_DESK")).toBe(true);
  });

  test("Housekeeping can read the room board with open tasks", async () => {
    await Room.update({ status: "DIRTY" }, { where: { roomNumber: "102" } });
    await housekeeping.post("/cleaning-tasks", { external_task_id: "HK-102B", room_number: "102" });
    const board = await housekeeping.get("/rooms?status=DIRTY");
    expect(board.data).toEqual([expect.objectContaining({ room_number: "102", status: "DIRTY", open_task: expect.objectContaining({ external_task_id: "HK-102B" }) })]);
    expect((await housekeeping.get("/rooms/204")).data).toMatchObject({ room_number: "204", status: "AVAILABLE", open_task: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Event delivery reliability", () => {
  test("every published event is logged once with a public event id and linked deliveries", async () => {
    const vacated = await IntegrationEvent.findOne({ where: { eventId: ctx.vacatedEventId } });
    expect(vacated).toMatchObject({ eventType: "RoomVacated", aggregateType: "ROOM" });
    const deliveries = await IntegrationOutbox.findAll({ where: { integrationEventId: vacated.id } });
    expect(deliveries.map((d) => d.target)).toEqual(["HOUSEKEEPING"]);
    expect(deliveries[0].status).toBe("SENT");
  });

  test("a failing receiver is retried with backoff, then the delivery is marked FAILED; an admin re-queues it", async () => {
    await processOutbox();
    hooks.HOUSEKEEPING.respondWith(503);
    hooks.HOUSEKEEPING.clear();
    const r204 = await room("204");
    expect((await admin.patch(`/admin/rooms/${r204.id}`, { status: "MAINTENANCE" })).status).toBe(200);
    const row = await IntegrationOutbox.findOne({ where: { target: "HOUSEKEEPING", eventType: "RoomStatusChanged" }, order: [["id", "DESC"]] });

    await processOutbox();
    await row.reload();
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastResponseStatus: 503, lastError: "HTTP 503" });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // backoff ≈ 30 s

    for (const attempt of [2, 3]) {
      await row.update({ nextAttemptAt: new Date() });
      await processOutbox();
      await row.reload();
      expect(row.attempts).toBe(attempt);
    }
    expect(row.status).toBe("FAILED"); // INTEGRATION_OUTBOX_MAX_ATTEMPTS = 3 in tests
    expect(new Set(hooks.HOUSEKEEPING.received.map((r) => r.body.event_id))).toEqual(new Set([row.payload.event_id]));

    const dashboard = await admin.get("/dashboard");
    expect(dashboard.data.notifications.some((n) => /could not be delivered/.test(n.text))).toBe(true);

    hooks.HOUSEKEEPING.respondWith(200);
    const retried = await admin.post(`/admin/integrations/outbox/${row.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.data.status).toBe("SENT");
    ctx.redeliverRow = row.id;
  });

  test("duplicate delivery of the same event carries the same event_id, so receivers can de-duplicate", async () => {
    hooks.HOUSEKEEPING.clear();
    await admin.post(`/admin/integrations/outbox/${ctx.redeliverRow}/retry`); // re-send an already delivered event
    await admin.post(`/admin/integrations/outbox/${ctx.redeliverRow}/retry`);
    const delivered = hooks.HOUSEKEEPING.events("RoomStatusChanged");
    expect(delivered).toHaveLength(2);
    const processed = new Map(delivered.map((e) => [e.event_id, e])); // receiver-side de-duplication
    expect(processed.size).toBe(1);
    expect(new Set(hooks.HOUSEKEEPING.received.map((r) => r.headers["x-pms-delivery"])).size).toBe(1);
  });

  test("the admin console shows every integration's (non-secret) status", async () => {
    const res = await admin.get("/admin/integrations");
    expect(res.data.status.clients.map((c) => c.source)).toEqual(["BOOKING", "POS", "HOUSEKEEPING", "HR"]);
    const hk = res.data.status.clients.find((c) => c.source === "HOUSEKEEPING");
    expect(hk).toMatchObject({ enabled: true, inboundSigned: true, webhookConfigured: true, webhookSigned: true, webhookEvents: ["RoomVacated", "RoomStatusChanged", "RoomCleaned"] });
    expect(JSON.stringify(res.data)).not.toContain(process.env.HOUSEKEEPING_API_KEY);
    expect(res.data.outbox[0]).toHaveProperty("eventId");
  });
});
