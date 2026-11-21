/**
 * Room synchronisation (Frontdesk → OnlineBooking / RoomCare), checkout →
 * RoomCare cleaning notification, RoomCare cleaning status callbacks, and the
 * Admin Console integration monitor. docs/ROOM_SYNC.md.
 *
 * IMPORTANT: OnlineBooking and RoomCare have not published their room APIs.
 * The two receivers below speak a TEST-ONLY contract (POST /rooms, PUT
 * /rooms/:id, POST /rooms/:id/deactivate) that exists solely to exercise the
 * Frontdesk side: queueing, mapping, retries, idempotency, coalescing,
 * independent failures and monitoring. It is NOT the real contract; the real
 * adapters (integrations/roomSync/adapters.js) stay "contract pending" and
 * the first tests prove that nothing is sent through them.
 */
import http from "http";

// Room sync targets must be configured before the app's config is loaded (dynamic imports below).
process.env.STAYBOOK_API_URL = "http://127.0.0.1:39126";
process.env.STAYBOOK_API_TOKEN = "test-staybook-outbound-token";
process.env.ROOMCARE_API_URL = "http://127.0.0.1:39127";
process.env.ROOMCARE_API_TOKEN = "test-roomcare-outbound-token";
process.env.ROOM_SYNC_MAX_ATTEMPTS = "3";
process.env.ROOM_SYNC_TIMEOUT_MS = "2000";

let H; // harness
let M; // models
let sync; // roomSyncService
let adapters;
let httpLib;
let processOutbox;
let app;
let admin;
let desk;
let housekeeping;
let staybook;
let hk;
const sim = {};
let D;

/** Simulated room API of one external system (test-only contract, see header). */
async function startRoomApi(port, prefix, token) {
  const state = { rooms: new Map(), byKey: new Map(), requests: [], seq: 0, mode: "ok", failNext: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, json) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
      if (state.mode === "down" || (state.failNext > 0 && state.failNext--)) return send(503, { error: "maintenance" });
      if (state.mode === "reject") return send(422, { error: "room_type not supported" });

      if (req.method === "POST" && req.url === "/rooms") {
        const key = req.headers["idempotency-key"];
        if (key && state.byKey.has(key)) return send(200, { id: state.byKey.get(key), replayed: true });
        const id = `${prefix}-${++state.seq}`;
        state.rooms.set(id, { ...body, active: true });
        if (key) state.byKey.set(key, id);
        if (state.mode === "lose-answer") {
          state.mode = "ok";
          return send(500, { error: "created, but the answer was lost" });
        }
        return send(201, { id });
      }
      const m = req.url.match(/^\/rooms\/([^/]+)(\/deactivate)?$/);
      if (m && state.rooms.has(m[1])) {
        if (req.method === "PUT" && !m[2]) {
          state.rooms.set(m[1], { ...body, active: body.is_active });
          return send(200, { id: m[1], updated: true });
        }
        if (req.method === "POST" && m[2]) {
          state.rooms.get(m[1]).active = false;
          return send(200, { id: m[1], active: false });
        }
      }
      return send(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    state,
    reset() {
      state.requests.length = 0;
      state.mode = "ok";
      state.failNext = 0;
    },
    count: (method, re) => state.requests.filter((r) => r.method === method && (!re || re.test(r.url))).length,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Adapter for the simulated API (shape of a real adapter once a contract exists). */
const simAdapter = (target, label) => ({
  target,
  label,
  ready: () => true,
  missing: [],
  async create(room, ctx) {
    const r = await httpLib.requestJson({
      method: "POST",
      url: `${ctx.baseUrl}/rooms`,
      headers: { Authorization: `Bearer ${ctx.token}`, "Idempotency-Key": ctx.idempotencyKey },
      body: room,
      timeoutMs: ctx.timeoutMs,
    });
    return { externalRoomId: r.body.id, status: r.status, body: r.body };
  },
  async update(id, room, ctx) {
    const r = await httpLib.requestJson({ method: "PUT", url: `${ctx.baseUrl}/rooms/${id}`, headers: { Authorization: `Bearer ${ctx.token}`, "Idempotency-Key": ctx.idempotencyKey }, body: room, timeoutMs: ctx.timeoutMs });
    return { status: r.status, body: r.body };
  },
  async deactivate(id, room, ctx) {
    const r = await httpLib.requestJson({ method: "POST", url: `${ctx.baseUrl}/rooms/${id}/deactivate`, headers: { Authorization: `Bearer ${ctx.token}`, "Idempotency-Key": ctx.idempotencyKey }, body: {}, timeoutMs: ctx.timeoutMs });
    return { status: r.status, body: r.body };
  },
});

const jobsOf = (roomId, where = {}) => M.RoomSyncJob.findAll({ where: { roomId, ...where }, order: [["id", "ASC"]] });
const openJob = async (roomId, target) => M.RoomSyncJob.findOne({ where: { roomId, target, status: M.OPEN_ROOM_SYNC_STATUSES } });
const mappingOf = async (roomId, target) => (await M.ExternalRoomMapping.findOne({ where: { roomId, sourceSystem: target } }))?.externalRoomId ?? null;
/** Makes every backed-off job due now (instead of waiting 30 s+). */
const dueNow = () => M.RoomSyncJob.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { where: { status: "PENDING" } });
const createRoom = (roomNumber, extra = {}) =>
  admin.post("/admin/rooms", { roomNumber, roomType: "Deluxe", capacity: 2, nightlyRate: "3600.00", description: "Garden view", amenities: ["WiFi", "Aircon"], ...extra });

beforeAll(async () => {
  H = await import("./helpers/harness.js");
  M = await import("../models/index.js");
  sync = await import("../integrations/roomSync/roomSyncService.js");
  adapters = await import("../integrations/roomSync/adapters.js");
  httpLib = await import("../integrations/roomSync/http.js");
  ({ processOutbox } = await import("../integrations/shared/outbox.js"));
  const dates = await import("../utils/dates.js");
  D = (n) => dates.addDays(dates.today(), n);

  await H.resetDatabase();
  app = await H.startApp();
  admin = await new H.StaffClient(app.base).login("admin", H.PASSWORDS.admin);
  desk = await new H.StaffClient(app.base).login("frontdesk", H.PASSWORDS.frontdesk);
  housekeeping = new H.IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY, { signingSecret: process.env.HOUSEKEEPING_INBOUND_SECRET });
  staybook = new H.IntegrationClient(app.base, "staybook", process.env.BOOKING_API_KEY);
  sim.STAYBOOK = await startRoomApi(39126, "SB", process.env.STAYBOOK_API_TOKEN);
  sim.ROOMCARE = await startRoomApi(39127, "RC", process.env.ROOMCARE_API_TOKEN);
  hk = await H.startReceiver("HOUSEKEEPING", process.env.HOUSEKEEPING_WEBHOOK_SECRET);
});
afterAll(async () => {
  adapters?.resetAdapters();
  await sim.STAYBOOK?.close();
  await sim.ROOMCARE?.close();
  await hk?.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Before the external API contracts exist (real adapters)", () => {
  test("creating a room works as before; both systems get a BLOCKED job and nothing is sent", async () => {
    const res = await createRoom("401");
    expect(res.status).toBe(201);
    const jobs = await jobsOf(res.data.id);
    expect(jobs.map((j) => [j.target, j.status])).toEqual(expect.arrayContaining([["STAYBOOK", "BLOCKED"], ["ROOMCARE", "BLOCKED"]]));
    expect(jobs[0].lastError).toMatch(/contract is not implemented/);

    await sync.processRoomSync();
    expect(sim.STAYBOOK.state.requests).toHaveLength(0);
    expect(sim.ROOMCARE.state.requests).toHaveLength(0);
    expect((await jobsOf(res.data.id)).every((j) => j.status === "BLOCKED" && j.attempts === 0)).toBe(true);
  });

  test("the monitor reports AWAITING_CONTRACT and lists what each system must provide", async () => {
    const res = await admin.get("/admin/integrations/room-sync");
    expect(res.status).toBe(200);
    const byTarget = Object.fromEntries(res.data.targets.map((t) => [t.target, t]));
    for (const t of ["STAYBOOK", "ROOMCARE"]) {
      expect(byTarget[t]).toMatchObject({ configured: true, contractReady: false, connection: "AWAITING_CONTRACT", lastSuccessAt: null });
      expect(byTarget[t].missing.length).toBeGreaterThan(3);
      expect(byTarget[t].counts.BLOCKED).toBeGreaterThanOrEqual(1);
    }
    expect(res.data.webhooks.ROOMCARE).toMatchObject({ target: "HOUSEKEEPING", configured: true });
  });

  test("an admin retry of a BLOCKED job keeps it BLOCKED (still nothing sent)", async () => {
    const job = await openJob((await M.Room.findOne({ where: { roomNumber: "401" } })).id, "ROOMCARE");
    const res = await admin.post(`/admin/integrations/room-sync/${job.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("BLOCKED");
    expect(sim.ROOMCARE.state.requests).toHaveLength(0);
  });

  test("a room deleted before it ever reached an external system is deleted for good, with its jobs", async () => {
    const res = await createRoom("499");
    const del = await admin.api("DELETE", `/admin/rooms/${res.data.id}`);
    expect(del.status).toBe(200);
    expect(del.data.mode).toBe("deleted");
    expect(await M.RoomSyncJob.count({ where: { roomId: res.data.id } })).toBe(0);
  });

  test("a refused room change (duplicate number) creates no job", async () => {
    const before = await M.RoomSyncJob.count();
    expect((await createRoom("401")).status).toBe(409);
    expect(await M.RoomSyncJob.count()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Room creation and updates, once an adapter is implemented (simulated systems)", () => {
  let roomId;
  beforeAll(() => {
    adapters.registerAdapter(simAdapter("STAYBOOK", "OnlineBooking (simulated)"));
    adapters.registerAdapter(simAdapter("ROOMCARE", "RoomCare (simulated)"));
  });

  test("blocked jobs are released automatically and the room is created in both systems; ids are mapped", async () => {
    roomId = (await M.Room.findOne({ where: { roomNumber: "401" } })).id;
    await sync.processRoomSync();
    for (const t of ["STAYBOOK", "ROOMCARE"]) {
      const [job] = await jobsOf(roomId, { target: t });
      expect(job).toMatchObject({ status: "SYNCED", operation: "CREATE", attempts: 1, lastResponseStatus: 201, idempotencyKey: `frontdesk:room:${roomId}:${t.toLowerCase()}:create` });
      expect(job.externalRoomId).toBe(await mappingOf(roomId, t));
    }
    expect(await mappingOf(roomId, "STAYBOOK")).toBe("SB-1");
    expect(await mappingOf(roomId, "ROOMCARE")).toBe("RC-1");
    const sent = sim.ROOMCARE.state.requests.find((r) => r.method === "POST");
    expect(sent.body).toMatchObject({
      frontdesk_room_id: roomId,
      room_number: "401",
      room_type: "Deluxe",
      capacity: 2,
      nightly_rate: 3600,
      currency: "PHP",
      description: "Garden view",
      amenities: ["WiFi", "Aircon"],
      status: "AVAILABLE",
      occupancy_status: "VACANT_CLEAN",
      is_active: true,
    });
    expect(sent.headers.authorization).toBe(`Bearer ${process.env.ROOMCARE_API_TOKEN}`);
  });

  test("a new room is created in both systems with one request each", async () => {
    sim.STAYBOOK.reset();
    sim.ROOMCARE.reset();
    const res = await createRoom("402", { roomType: "Family", capacity: 4, nightlyRate: "5200.00" });
    await sync.processRoomSync();
    expect(sim.STAYBOOK.count("POST", /^\/rooms$/)).toBe(1);
    expect(sim.ROOMCARE.count("POST", /^\/rooms$/)).toBe(1);
    expect(await mappingOf(res.data.id, "STAYBOOK")).toMatch(/^SB-/);
  });

  test("editing a room updates the mapped records (no new room); edits before delivery coalesce into one request", async () => {
    sim.STAYBOOK.reset();
    sim.ROOMCARE.reset();
    expect((await admin.patch(`/admin/rooms/${roomId}`, { capacity: 3 })).status).toBe(200);
    expect((await admin.patch(`/admin/rooms/${roomId}`, { nightlyRate: "3900.00", amenities: ["WiFi", "Aircon", "Bathtub"] })).status).toBe(200);
    const job = await openJob(roomId, "STAYBOOK");
    expect(job).toMatchObject({ status: "PENDING", version: 2 });
    expect(job.trigger).toBe("UPDATED(capacity); UPDATED(nightlyRate,amenities)");

    await sync.processRoomSync();
    for (const t of ["STAYBOOK", "ROOMCARE"]) {
      expect(sim[t].count("POST", /^\/rooms$/)).toBe(0);
      expect(sim[t].count("PUT")).toBe(1);
    }
    const put = sim.STAYBOOK.state.requests.find((r) => r.method === "PUT");
    expect(put.url).toBe("/rooms/SB-1");
    expect(put.body).toMatchObject({ capacity: 3, nightly_rate: 3900, amenities: ["WiFi", "Aircon", "Bathtub"] });
    expect(await M.RoomSyncJob.count({ where: { roomId, target: "STAYBOOK", status: "SYNCED" } })).toBe(2);
  });

  test("saving a room without real changes sends nothing", async () => {
    sim.STAYBOOK.reset();
    const before = await M.RoomSyncJob.count();
    expect((await admin.patch(`/admin/rooms/${roomId}`, { capacity: 3 })).status).toBe(200);
    expect(await M.RoomSyncJob.count()).toBe(before);
    expect(await openJob(roomId, "STAYBOOK")).toBeNull();
  });

  test("room number change, deactivation and maintenance are synchronised", async () => {
    sim.STAYBOOK.reset();
    await admin.patch(`/admin/rooms/${roomId}`, { roomNumber: "401A" });
    await sync.processRoomSync();
    expect(sim.STAYBOOK.state.rooms.get("SB-1")).toMatchObject({ room_number: "401A" });
    await admin.patch(`/admin/rooms/${roomId}`, { isActive: false });
    await sync.processRoomSync();
    expect(sim.ROOMCARE.state.rooms.get("RC-1")).toMatchObject({ is_active: false });
    await admin.patch(`/admin/rooms/${roomId}`, { isActive: true, status: "MAINTENANCE" });
    await sync.processRoomSync();
    expect(sim.ROOMCARE.state.rooms.get("RC-1")).toMatchObject({ is_active: true, status: "MAINTENANCE", occupancy_status: "OUT_OF_ORDER" });
    await admin.patch(`/admin/rooms/${roomId}`, { status: "AVAILABLE" });
    await sync.processRoomSync();
    expect(sim.ROOMCARE.state.rooms.get("RC-1")).toMatchObject({ status: "AVAILABLE" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Failures, retries and duplicates", () => {
  test("one system down does not affect the other; the failed side retries with backoff and catches up", async () => {
    sim.STAYBOOK.reset();
    sim.ROOMCARE.reset();
    sim.STAYBOOK.state.mode = "down";
    const res = await createRoom("403");
    expect(res.status).toBe(201); // the Frontdesk change never waits for the external systems
    await sync.processRoomSync();
    const sb = await openJob(res.data.id, "STAYBOOK");
    expect(sb).toMatchObject({ status: "PENDING", attempts: 1, lastResponseStatus: 503, lastError: "HTTP 503" });
    expect(sb.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await mappingOf(res.data.id, "ROOMCARE")).toMatch(/^RC-/);

    // Not due yet: nothing is re-sent.
    await sync.processRoomSync();
    expect(sim.STAYBOOK.count("POST")).toBe(1);

    sim.STAYBOOK.state.mode = "ok";
    await dueNow();
    await sync.processRoomSync();
    expect((await jobsOf(res.data.id, { target: "STAYBOOK" }))[0]).toMatchObject({ status: "SYNCED", attempts: 2 });
    expect(await mappingOf(res.data.id, "STAYBOOK")).toMatch(/^SB-/);
  });

  test("a create whose answer was lost is retried with the same Idempotency-Key: exactly one external room", async () => {
    sim.ROOMCARE.reset();
    sim.ROOMCARE.state.mode = "lose-answer";
    const before = sim.ROOMCARE.state.rooms.size;
    const res = await createRoom("404");
    await sync.processRoomSync();
    expect((await openJob(res.data.id, "ROOMCARE")).status).toBe("PENDING");
    await dueNow();
    await sync.processRoomSync();
    const posts = sim.ROOMCARE.state.requests.filter((r) => r.method === "POST" && r.url === "/rooms");
    expect(posts).toHaveLength(2);
    expect(posts[0].headers["idempotency-key"]).toBe(posts[1].headers["idempotency-key"]);
    expect(sim.ROOMCARE.state.rooms.size).toBe(before + 1);
    expect(await M.ExternalRoomMapping.count({ where: { roomId: res.data.id, sourceSystem: "ROOMCARE" } })).toBe(1);
  });

  test("retries stop after ROOM_SYNC_MAX_ATTEMPTS: the job is FAILED with the last error", async () => {
    sim.STAYBOOK.state.mode = "down";
    const res = await createRoom("405");
    for (let i = 0; i < 3; i++) {
      await dueNow();
      await sync.processRoomSync();
    }
    expect(await openJob(res.data.id, "STAYBOOK")).toMatchObject({ status: "FAILED", attempts: 3, lastResponseStatus: 503 });
    sim.STAYBOOK.state.mode = "ok";
  });

  test("a refusal (4xx) fails at once; the admin fixes the cause and retries; a synced job cannot be retried", async () => {
    sim.ROOMCARE.state.mode = "reject";
    const res = await createRoom("406");
    await sync.processRoomSync();
    const failed = await openJob(res.data.id, "ROOMCARE");
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1, lastResponseStatus: 422 });
    expect(failed.lastResponseBody).toContain("room_type not supported");

    sim.ROOMCARE.state.mode = "ok";
    const retried = await admin.post(`/admin/integrations/room-sync/${failed.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.data).toMatchObject({ status: "SYNCED", operation: "CREATE" });
    const again = await admin.post(`/admin/integrations/room-sync/${failed.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("ROOM_SYNC_NOT_RETRYABLE");
  });

  test("a new change replaces an older FAILED job (one open job per room and system)", async () => {
    sim.STAYBOOK.state.mode = "reject";
    const res = await createRoom("407");
    await sync.processRoomSync();
    const failed = await openJob(res.data.id, "STAYBOOK");
    expect(failed.status).toBe("FAILED");
    sim.STAYBOOK.state.mode = "ok";
    await admin.patch(`/admin/rooms/${res.data.id}`, { description: "Fixed description" });
    expect((await failed.reload()).status).toBe("SUPERSEDED");
    await sync.processRoomSync();
    expect(await M.RoomSyncJob.count({ where: { roomId: res.data.id, target: "STAYBOOK", status: M.OPEN_ROOM_SYNC_STATUSES } })).toBe(0);
    expect(await mappingOf(res.data.id, "STAYBOOK")).toMatch(/^SB-/);
  });

  test("an edit made while a request is in flight is sent afterwards (not lost)", async () => {
    const room = await M.Room.findOne({ where: { roomNumber: "402" } });
    let release;
    const gate = new Promise((r) => (release = r));
    const real = simAdapter("STAYBOOK", "OnlineBooking (simulated)");
    adapters.registerAdapter({
      ...real,
      async update(id, snapshot, ctx) {
        await gate;
        return real.update(id, snapshot, ctx);
      },
    });
    await admin.patch(`/admin/rooms/${room.id}`, { description: "First edit" });
    const inFlight = sync.processRoomSync();
    await new Promise((r) => setTimeout(r, 150));
    await admin.patch(`/admin/rooms/${room.id}`, { description: "Second edit" });
    release();
    await inFlight;
    adapters.registerAdapter(real);
    expect((await openJob(room.id, "STAYBOOK"))?.status).toBe("PENDING");
    await sync.processRoomSync();
    expect(sim.STAYBOOK.state.rooms.get(await mappingOf(room.id, "STAYBOOK"))).toMatchObject({ description: "Second edit" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Deleting and restoring a synchronised room", () => {
  test("a room known to the external systems is archived (not deleted) and deactivated there — never deleted", async () => {
    const room = await M.Room.findOne({ where: { roomNumber: "403" } });
    sim.STAYBOOK.reset();
    sim.ROOMCARE.reset();
    const del = await admin.api("DELETE", `/admin/rooms/${room.id}`);
    expect(del.status).toBe(200);
    expect(del.data).toMatchObject({ mode: "archived", externalSystems: 2 });
    await sync.processRoomSync();
    for (const t of ["STAYBOOK", "ROOMCARE"]) {
      expect(sim[t].count("POST", /\/deactivate$/)).toBe(1);
      expect(sim[t].count("DELETE")).toBe(0);
      expect(sim[t].state.rooms.get(await mappingOf(room.id, t)).active).toBe(false);
    }
    expect(await M.Room.findByPk(room.id)).not.toBeNull();
  });

  test("restoring it re-activates the same external records", async () => {
    const room = await M.Room.findOne({ where: { roomNumber: "403" } });
    expect((await admin.post(`/admin/rooms/${room.id}/restore`)).status).toBe(200);
    await sync.processRoomSync();
    expect(sim.ROOMCARE.state.rooms.get(await mappingOf(room.id, "ROOMCARE"))).toMatchObject({ is_active: true, active: true });
    expect(sim.ROOMCARE.count("POST", /^\/rooms$/)).toBe(0);
  });

  test("'sync all rooms' queues every room for one system and brings the seeded rooms in", async () => {
    sim.ROOMCARE.reset();
    const res = await admin.post("/admin/integrations/room-sync/resync", { target: "ROOMCARE" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ target: "ROOMCARE", blocked: null });
    expect(res.data.queued).toBeGreaterThanOrEqual(10);
    const seeded = await M.Room.findOne({ where: { roomNumber: "204" } });
    expect(await mappingOf(seeded.id, "ROOMCARE")).toMatch(/^RC-/);
    expect(await M.Room.count({ where: { archivedAt: null } })).toBe(await M.ExternalRoomMapping.count({ where: { sourceSystem: "ROOMCARE" } }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Checkout → RoomCare cleaning notification → cleaning status → room ready", () => {
  const ctx = {};

  test("checkout succeeds even while RoomCare is down; the room is VACANT_DIRTY and the notification waits for retry", async () => {
    const r204 = await M.Room.findOne({ where: { roomNumber: "204" } });
    const reservation = await desk.post("/reservations", {
      guest: { firstName: "Ana", lastName: "Reyes", email: `ana.${Date.now()}@example.com` },
      roomId: r204.id,
      checkInDate: D(0),
      checkOutDate: D(1),
      numGuests: 1,
    });
    expect(reservation.status).toBe(201);
    await desk.post("/verifications", { reservationId: reservation.data.id, idType: "PASSPORT", idNumberLast4: "1234", nameOnId: "Ana Reyes", expiryDate: D(3650), photoMatches: true });
    const stay = await desk.post("/check-ins", { reservationId: reservation.data.id });
    expect(stay.status).toBe(201);
    const bill = (await desk.post("/bills", { stayId: stay.data.id })).data.bill;
    await desk.post(`/bills/${bill.id}/confirm`);
    await desk.post("/payments", { billId: bill.id, method: "CASH", amount: bill.totals.totalDue });

    hk.respondWith(503);
    hk.clear();
    const out = await desk.post("/checkouts", { stayId: stay.data.id });
    expect(out.status).toBe(201);
    expect((await r204.reload()).status).toBe("DIRTY");
    await processOutbox();
    const delivery = await M.IntegrationOutbox.findOne({ where: { target: "HOUSEKEEPING", eventType: "RoomVacated" }, order: [["id", "DESC"]] });
    expect(delivery).toMatchObject({ status: "PENDING", attempts: 1, lastResponseStatus: 503 });
    expect(delivery.lastResponseBody).toBe("unavailable");
    ctx.room = r204;
    ctx.reservationCode = reservation.data.reservationCode;
  });

  test("when RoomCare is back, the notification is delivered once with the cleaning message, event id and RoomCare room id", async () => {
    hk.respondWith(200);
    await M.IntegrationOutbox.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { where: { status: "PENDING" } });
    await processOutbox();
    const vacated = hk.events("RoomVacated");
    expect(vacated).toHaveLength(1);
    expect(vacated[0]).toMatchObject({
      room_number: "204",
      room_id: ctx.room.id,
      roomcare_room_id: await mappingOf(ctx.room.id, "ROOMCARE"),
      reason: "CHECKOUT",
      room_status: "DIRTY",
      cleaning_status: "PENDING",
      message: "Room 204 needs cleaning. A guest has checked out. Please prepare the room for the next guest.",
      reservation_code: ctx.reservationCode,
    });
    expect(vacated[0].event_id).toMatch(/^EVT-\d{6}$/);
    expect(vacated[0].checkout_time).toBeTruthy();
    ctx.eventId = vacated[0].event_id;
    // A duplicate delivery (admin re-send) carries the same event_id, so RoomCare can ignore it.
    const row = await M.IntegrationOutbox.findOne({ where: { target: "HOUSEKEEPING", eventType: "RoomVacated" }, order: [["id", "DESC"]] });
    expect(row.status).toBe("SENT");
  });

  test("OnlineBooking sees the room as not ready while it is dirty", async () => {
    await M.ExternalRoomMapping.findOrCreate({ where: { sourceSystem: "STAYBOOK", roomId: ctx.room.id }, defaults: { externalRoomId: "SB-204" } });
    const res = await staybook.get("/rooms");
    expect(res.status).toBe(200);
    expect(res.data.rooms.find((r) => r.frontdesk_room_id === ctx.room.id)).toMatchObject({ room_status: "DIRTY", occupancy_status: "VACANT_DIRTY", ready_for_guest: false });
  });

  test("RoomCare reports PENDING then IN_PROGRESS through the single status callback", async () => {
    const pending = await housekeeping.post("/cleaning-status", { status: "PENDING", external_task_id: "RC-TASK-1", room_number: "204", event_id: ctx.eventId });
    expect(pending.status).toBe(201);
    expect(pending.data).toMatchObject({ cleaning_status: "PENDING", task_status: "OPEN", room_status: "DIRTY", source_event_id: ctx.eventId });
    const started = await housekeeping.post("/cleaning-status", { status: "IN_PROGRESS", external_task_id: "RC-TASK-1", room_number: "204", started_by: "HK-07" });
    expect(started.status).toBe(200);
    expect(started.data).toMatchObject({ cleaning_status: "IN_PROGRESS", room_status: "CLEANING" });
    expect((await ctx.room.reload()).status).toBe("CLEANING");
  });

  test("callbacks are validated: unsigned, wrong key, bad status or missing fields are refused and change nothing", async () => {
    const body = { status: "COMPLETED", external_task_id: "RC-TASK-1", room_number: "204", completed_by: "HK-07", completed_at: new Date().toISOString() };
    expect((await housekeeping.post("/cleaning-status", body, { sign: false })).status).toBe(401);
    expect((await housekeeping.post("/cleaning-status", body, { apiKey: "wrong-key" })).status).toBe(401);
    expect((await housekeeping.post("/cleaning-status", { ...body, status: "DONE" })).status).toBe(422);
    expect((await housekeeping.post("/cleaning-status", { ...body, completed_at: undefined })).status).toBe(422);
    expect((await ctx.room.reload()).status).toBe("CLEANING");
  });

  test("COMPLETED: the room becomes VACANT_CLEAN, the completion time is stored, and OnlineBooking sees it ready", async () => {
    const completedAt = new Date().toISOString(); // after the IN_PROGRESS start (completion before start is refused)
    const key = H.newKey("rc");
    const body = { status: "COMPLETED", external_task_id: "RC-TASK-1", room_number: "204", completed_by: "HK-07", completed_at: completedAt };
    const done = await housekeeping.post("/cleaning-status", body, { key });
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ cleaning_status: "COMPLETED", task_status: "COMPLETED", room_status: "AVAILABLE", previous_room_status: "CLEANING" });
    await ctx.room.reload();
    expect(ctx.room.status).toBe("AVAILABLE");
    expect(Math.abs(new Date(ctx.room.lastCleanedAt) - new Date(completedAt))).toBeLessThan(1000);

    const replay = await housekeeping.post("/cleaning-status", body, { key });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect((await housekeeping.post("/cleaning-status", body)).error.code).toBe("DUPLICATE_CLEANING_COMPLETION");

    const states = await staybook.get("/rooms");
    expect(states.data.rooms.find((r) => r.frontdesk_room_id === ctx.room.id)).toMatchObject({ occupancy_status: "VACANT_CLEAN", ready_for_guest: true });
  });

  test("the cleaning notification history shows delivery, RoomCare's answer and the completed task", async () => {
    const res = await admin.get("/admin/integrations/cleaning-notifications");
    expect(res.status).toBe(200);
    expect(res.data.roomcare).toMatchObject({ target: "HOUSEKEEPING", configured: true, connection: "CONNECTED" });
    const n = res.data.notifications.find((x) => x.eventId === ctx.eventId);
    expect(n).toMatchObject({
      roomNumber: "204",
      reason: "CHECKOUT",
      cleaningStatus: "COMPLETED",
      occupancyStatus: "VACANT_CLEAN",
      delivery: { status: "SENT", attempts: 2, lastResponseStatus: 200 },
      task: { externalTaskId: "RC-TASK-1", status: "COMPLETED" },
    });
    expect(n.roomcareRoomId).toMatch(/^RC-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Integration monitoring", () => {
  test("connection status, last success, failures and history per system", async () => {
    const res = await admin.get("/admin/integrations/room-sync");
    const rc = res.data.targets.find((t) => t.target === "ROOMCARE");
    expect(rc).toMatchObject({ contractReady: true, connection: "CONNECTED", lastError: null });
    expect(new Date(rc.lastSuccessAt).getTime()).toBeGreaterThan(Date.now() - 120_000);
    expect(rc.counts.SYNCED).toBeGreaterThan(5);
    const sb = res.data.targets.find((t) => t.target === "STAYBOOK");
    expect(sb.counts.FAILED).toBeGreaterThanOrEqual(1); // room 405, retries exhausted
    expect(res.data.jobs.length).toBeGreaterThan(0);
    expect(res.data.jobs[0]).toHaveProperty("idempotencyKey");

    const failedOnly = await admin.get("/admin/integrations/room-sync?status=FAILED");
    expect(failedOnly.data.jobs.every((j) => j.status === "FAILED")).toBe(true);
  });

  test("monitoring and retries are for administrators only (CSRF required on actions)", async () => {
    expect((await desk.get("/admin/integrations/room-sync")).status).toBe(403);
    expect((await desk.get("/admin/integrations/cleaning-notifications")).status).toBe(403);
    expect((await desk.post("/admin/integrations/room-sync/resync", { target: "ROOMCARE" })).status).toBe(403);
    expect((await admin.api("POST", "/admin/integrations/room-sync/resync", { target: "ROOMCARE" }, { csrf: false })).status).toBe(403);
  });

  test("the Integrations page still renders", async () => {
    const res = await admin.raw("GET", "/admin/integrations");
    expect(res.status).toBe(200);
  });
});
