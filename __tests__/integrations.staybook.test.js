/**
 * StayBook online booking (Member 1, room-based contract) against the PMS.
 * StayBook itself is simulated: IntegrationClient (and the reference client in
 * docs/staybook/frontdeskClient.js) plays StayBook's backend calling the PMS,
 * and a local webhook receiver plays StayBook's webhook endpoint.
 * No live StayBook deployment is contacted.
 */
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, startReceiver } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { Room, Reservation, Payment, ExternalBooking, IntegrationRequest, IntegrationOutbox } from "../models/index.js";
import { today, addDays } from "../utils/dates.js";
import { createFrontdeskClient, toFrontdeskReservation, syncOutcome, idempotencyKey } from "../docs/staybook/frontdeskClient.js";

let app;
let admin;
let desk;
let staybook;
let hooks;
const D0 = today();
const D = (n) => addDays(D0, n);
const REV = (n) => new Date(1_800_000_000_000 + n * 1000 + 123).toISOString();
const ids = {};
const ctx = {};

const roomStatus = async (n) => (await Room.findOne({ where: { roomNumber: n } })).status;
const deskView = async (id) => (await desk.get(`/reservations/${id}`)).data;

/** A StayBook booking as StayBook sends it (defaults: StayBook room 1 → Frontdesk 204 Deluxe). */
const booking = (n, extra = {}) => ({
  source_system: "STAYBOOK",
  source_booking_id: String(n),
  booking_reference: `SB-TEST${n}`,
  hotel_id: 1,
  staybook_room_id: 1,
  guest: { first_name: "Maria", last_name: "Santos", email: "maria@example.com", phone: "09171234567", address: "Bongabong, Oriental Mindoro" },
  check_in: D(5),
  check_out: D(7),
  guests: 2,
  nights: 2,
  nightly_rate: 3500,
  total_amount: 7000,
  currency: "PHP",
  booking_status: "LOCAL_CONFIRMED",
  payment_mode: "SIMULATED",
  updated_at: REV(1),
  ...extra,
});

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  staybook = new IntegrationClient(app.base, "staybook", process.env.BOOKING_API_KEY);
  hooks = await startReceiver("BOOKING", process.env.BOOKING_WEBHOOK_SECRET);
  for (const r of await Room.findAll()) ids[r.roomNumber] = r.id;
});
afterAll(async () => {
  await hooks?.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Room mapping (Admin Console)", () => {
  test("only administrators manage the mapping", async () => {
    expect((await desk.get("/admin/staybook/room-mappings")).status).toBe(403);
    expect((await desk.put("/admin/staybook/room-mappings/1", { roomId: ids["204"] })).status).toBe(403);
  });

  test("StayBook rooms are mapped explicitly onto Frontdesk rooms", async () => {
    // StayBook numbers its rooms independently: 1 → 204, 2 → 101, 3 → 102, 5 → 301 (StayBook 9 stays unmapped).
    for (const [sb, room] of [["1", "204"], ["2", "101"], ["3", "102"], ["5", "301"]]) {
      const res = await admin.put(`/admin/staybook/room-mappings/${sb}`, { roomId: ids[room] });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ staybookRoomId: sb, roomId: ids[room], roomNumber: room });
    }
    const list = await admin.get("/admin/staybook/room-mappings");
    expect(list.data.hotelId).toBe("1");
    expect(list.data.rooms.map((r) => [r.roomNumber, r.staybookRoomId])).toEqual([["101", "2"], ["102", "3"], ["204", "1"], ["301", "5"]]);
  });

  test("mapping rules: valid ids, existing rooms, one StayBook room per Frontdesk room", async () => {
    expect((await admin.put("/admin/staybook/room-mappings/bad id!", { roomId: ids["101"] })).status).toBe(422);
    expect((await admin.put("/admin/staybook/room-mappings/77", { roomId: 9999 })).status).toBe(404);
    const taken = await admin.put("/admin/staybook/room-mappings/77", { roomId: ids["101"] });
    expect(taken.status).toBe(409);
    expect(taken.error.code).toBe("ROOM_ALREADY_MAPPED");
    // replace: room 101 becomes StayBook 77 in one step; then back to 2.
    expect((await admin.put("/admin/staybook/room-mappings/77", { roomId: ids["101"], replace: true })).status).toBe(200);
    expect((await admin.put("/admin/staybook/room-mappings/2", { roomId: ids["101"], replace: true })).status).toBe(200);
    expect((await admin.api("DELETE", "/admin/staybook/room-mappings/77")).status).toBe(404);
    const list = await admin.get("/admin/staybook/room-mappings");
    expect(list.data.rooms.find((r) => r.roomNumber === "101").staybookRoomId).toBe("2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rooms/available", () => {
  test("mapped rooms bookable for the stay, by StayBook room id, with Frontdesk rates", async () => {
    const res = await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(7)}&guests=2&hotel_id=1`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ hotel_id: 1, check_in: D(5), check_out: D(7), nights: 2, guests: 2, currency: "PHP", unavailable_rooms: [] });
    expect(res.data.rooms.map((r) => r.staybook_room_id)).toEqual([2, 3, 1, 5]);
    expect(res.data.rooms.find((r) => r.staybook_room_id === 1)).toEqual({
      staybook_room_id: 1,
      frontdesk_room_id: ids["204"],
      room_number: "204",
      room_type: "Deluxe",
      capacity: 2,
      nightly_rate: 3500,
      stay_total: 7000,
    });
  });

  test("rooms too small for the party are reported with a reason", async () => {
    const res = await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(7)}&guests=3`);
    expect(res.data.rooms.map((r) => r.staybook_room_id)).toEqual([5]);
    expect(res.data.unavailable_rooms.map((r) => [r.staybook_room_id, r.reason])).toEqual([
      [2, "CAPACITY_EXCEEDED"],
      [3, "CAPACITY_EXCEEDED"],
      [1, "CAPACITY_EXCEEDED"],
    ]);
  });

  test("another StayBook hotel or invalid dates → 422", async () => {
    const other = await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(7)}&guests=2&hotel_id=2`);
    expect(other.status).toBe(422);
    expect(other.error.code).toBe("HOTEL_NOT_MANAGED");
    const backwards = await staybook.get(`/rooms/available?check_in=${D(7)}&check_out=${D(5)}&guests=2`);
    expect(backwards.status).toBe(422);
    expect(backwards.error.details.check_out).toBeDefined();
    const missing = await staybook.get("/rooms/available");
    expect(Object.keys(missing.error.details)).toEqual(expect.arrayContaining(["check_in", "check_out", "guests"]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /reservations — receive an online booking", () => {
  test("successful synchronisation: mapped room booked, acknowledgment returned, payment NOT recorded", async () => {
    const res = await staybook.post("/reservations", { ...booking(1001), card_number: "4242424242424242", payment_method: "VISA" });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      frontdesk_reservation_id: expect.any(Number),
      reservation_code: expect.stringMatching(/^RSV-\d+$/),
      source_system: "STAYBOOK",
      source_booking_id: 1001,
      booking_reference: "SB-TEST1001",
      hotel_id: 1,
      staybook_room_id: 1,
      frontdesk_room_id: ids["204"],
      room_number: "204",
      room_type: "Deluxe",
      room_assignment: "AS_BOOKED",
      check_in: D(5),
      check_out: D(7),
      guests: 2,
      nights: 2,
      nightly_rate: 3500,
      total_amount: 7000,
      currency: "PHP",
      frontdesk_nightly_rate: 3500,
      rate_matches_frontdesk: true,
      booking_status: "LOCAL_CONFIRMED",
      frontdesk_status: "CONFIRMED",
      payment_mode: "SIMULATED",
      payment_recorded: false,
      sync_status: "ACKNOWLEDGED",
      source_updated_at: REV(1),
    });
    ctx.main = res.data;
    ctx.mainKey = res.key;
    expect(await roomStatus("204")).toBe("RESERVED");

    // Privacy: the acknowledgment and the stored idempotent response carry no guest contact or card data.
    const stored = await IntegrationRequest.findOne({ where: { idempotencyKey: res.key } });
    for (const text of [JSON.stringify(res.body), JSON.stringify(stored.responseBody)]) {
      expect(text).not.toMatch(/maria@example\.com|09171234567|4242|Bongabong|VISA/);
    }

    // The front desk sees a normal reservation from the booking system — unpaid, with the quote in the notes.
    const view = await deskView(res.data.frontdesk_reservation_id);
    expect(view).toMatchObject({
      source: "RESERVATION_SYSTEM",
      externalReservationId: "SB-TEST1001",
      bookingReference: "SB-TEST1001",
      externalPaymentStatus: "UNPAID",
      status: "CONFIRMED",
      guest: { firstName: "Maria", lastName: "Santos", email: "maria@example.com" },
    });
    expect(view.notes).toMatch(/SIMULATED/);
    expect(view.notes).toMatch(/PHP 7000\.00/);
    expect(await Payment.count()).toBe(0);
  });

  test("a quoted rate different from the Frontdesk rate is accepted but flagged for the front desk", async () => {
    const res = await staybook.post("/reservations", booking(1002, { staybook_room_id: 5, check_in: D(12), check_out: D(13), nights: 1, nightly_rate: 4800, total_amount: 4800 }));
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ room_number: "301", nightly_rate: 4800, frontdesk_nightly_rate: 5200, rate_matches_frontdesk: false });
    expect((await deskView(res.data.frontdesk_reservation_id)).notes).toMatch(/Frontdesk rate for room 301 is PHP 5200\.00/);
  });

  test("invalid reservation data → 422 with the contract's field names; nothing stored", async () => {
    const before = await ExternalBooking.count();
    const empty = await staybook.post("/reservations", {});
    expect(empty.status).toBe(422);
    expect(Object.keys(empty.error.details)).toEqual(
      expect.arrayContaining([
        "source_system", "source_booking_id", "booking_reference", "guest", "hotel_id", "staybook_room_id", "check_in", "check_out",
        "guests", "nights", "nightly_rate", "total_amount", "currency", "updated_at", "booking_status",
      ])
    );
    const cases = [
      [{ check_in: D(9), check_out: D(8) }, "check_out"],
      [{ check_in: D(-1) }, "check_in"],
      [{ nights: 3 }, "nights"],
      [{ currency: "USD" }, "currency"],
      [{ guests: 3 }, "guests"], // Deluxe room 204 holds 2
      [{ booking_status: "CANCELLED" }, "booking_status"],
      [{ payment_mode: "CARD" }, "payment_mode"],
      [{ source_system: "OTHER" }, "source_system"],
      [{ guest: { first_name: "Maria" } }, "guest"],
      [{ total_amount: -5 }, "total_amount"],
      [{ updated_at: "yesterday" }, "updated_at"],
    ];
    for (const [extra, field] of cases) {
      const res = await staybook.post("/reservations", booking(1100, extra));
      expect([res.status, field, res.error.details?.[field] !== undefined]).toEqual([422, field, true]);
    }
    expect(await ExternalBooking.count()).toBe(before);
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST1100" } })).toBe(0);
  });

  test("invalid room mapping: unmapped room, mismatching frontdesk_room_id, room out of service, other hotel", async () => {
    const unmapped = await staybook.post("/reservations", booking(1200, { staybook_room_id: 9 }));
    expect(unmapped.status).toBe(422);
    expect(unmapped.error.code).toBe("ROOM_NOT_MAPPED");

    const mismatch = await staybook.post("/reservations", booking(1200, { staybook_room_id: 2, frontdesk_room_id: ids["204"] }));
    expect(mismatch.status).toBe(409);
    expect(mismatch.error).toMatchObject({ code: "ROOM_MAPPING_MISMATCH", details: { staybook_room_id: 2, frontdesk_room_id: ids["101"] } });

    const hotel = await staybook.post("/reservations", booking(1200, { hotel_id: 2 }));
    expect(hotel.status).toBe(422);
    expect(hotel.error.code).toBe("HOTEL_NOT_MANAGED");

    // Room 102 taken out of inventory at the front desk.
    expect((await admin.patch(`/admin/rooms/${ids["102"]}`, { isActive: false })).status).toBe(200);
    const outOfService = await staybook.post("/reservations", booking(1200, { staybook_room_id: 3 }));
    expect(outOfService.status).toBe(409);
    expect(outOfService.error.code).toBe("ROOM_OUT_OF_SERVICE");
    const avail = await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(7)}&guests=2`);
    expect(avail.data.unavailable_rooms).toEqual(expect.arrayContaining([expect.objectContaining({ staybook_room_id: 3, reason: "OUT_OF_SERVICE" })]));
    expect((await admin.patch(`/admin/rooms/${ids["102"]}`, { isActive: true })).status).toBe(200);

    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST1200" } })).toBe(0);
  });

  test("the mapped room already taken at the front desk (walk-in) → 409 ROOM_UNAVAILABLE, nothing stored", async () => {
    const walkIn = await desk.post("/reservations", { guest: { firstName: "Walk", lastName: "In" }, roomId: ids["101"], checkInDate: D(20), checkOutDate: D(22), numGuests: 1 });
    expect(walkIn.status).toBe(201);
    ctx.walkIn = walkIn.data;

    const avail = await staybook.get(`/rooms/available?check_in=${D(20)}&check_out=${D(22)}&guests=1`);
    expect(avail.data.unavailable_rooms).toEqual([expect.objectContaining({ staybook_room_id: 2, reason: "NOT_AVAILABLE" })]);

    const res = await staybook.post("/reservations", booking(1300, { staybook_room_id: 2, check_in: D(21), check_out: D(23), guests: 1, nightly_rate: 2500, total_amount: 5000 }));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_UNAVAILABLE");
    expect(await ExternalBooking.count({ where: { bookingReference: "SB-TEST1300" } })).toBe(0);
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST1300" } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Duplicate prevention", () => {
  test("retry with the same Idempotency-Key → original response replayed, nothing created twice", async () => {
    const res = await staybook.post("/reservations", { ...booking(1001), card_number: "4242424242424242", payment_method: "VISA" }, { key: ctx.mainKey });
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(res.data.frontdesk_reservation_id).toBe(ctx.main.frontdesk_reservation_id);
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST1001" } })).toBe(1);
  });

  test("same key with a different body → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const res = await staybook.post("/reservations", booking(1001, { guests: 1 }), { key: ctx.mainKey });
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("the same booking under a new key, or the same StayBook id under another reference → 409 DUPLICATE_RESERVATION", async () => {
    const again = await staybook.post("/reservations", booking(1001));
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("DUPLICATE_RESERVATION");
    expect(again.error.details).toMatchObject({ frontdesk_reservation_id: ctx.main.frontdesk_reservation_id, booking_reference: "SB-TEST1001" });

    const sameId = await staybook.post("/reservations", booking(1001, { booking_reference: "SB-OTHER-REF" }));
    expect(sameId.status).toBe(409);
    expect(sameId.error.code).toBe("DUPLICATE_RESERVATION");
  });

  test("simultaneous deliveries of one booking: exactly one reservation", async () => {
    const send = () => staybook.post("/reservations", booking(4001, { staybook_room_id: 3, check_in: D(30), check_out: D(31), nights: 1, nightly_rate: 2500, total_amount: 2500 }));
    const results = await Promise.all([send(), send(), send()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).map((r) => r.error.code)).toEqual(["DUPLICATE_RESERVATION", "DUPLICATE_RESERVATION"]);
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST4001" } })).toBe(1);
    expect(await ExternalBooking.count({ where: { bookingReference: "SB-TEST4001" } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /reservations/{id}", () => {
  test("by Frontdesk reservation id or by StayBook reference", async () => {
    const byId = await staybook.get(`/reservations/${ctx.main.frontdesk_reservation_id}`);
    const byRef = await staybook.get("/reservations/SB-TEST1001");
    expect(byId.status).toBe(200);
    expect(byRef.data).toEqual(byId.data);
    expect(byId.data).toMatchObject({ booking_reference: "SB-TEST1001", frontdesk_status: "CONFIRMED" });
  });

  test("unknown, malformed, and front-desk-only reservations are not visible → 404", async () => {
    expect((await staybook.get("/reservations/SB-NOPE")).error.code).toBe("RESERVATION_NOT_FOUND");
    expect((await staybook.get("/reservations/bad%20id")).status).toBe(404);
    const local = await staybook.get(`/reservations/${ctx.walkIn.id}`);
    expect(local.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /reservations/{id} — reservation updates", () => {
  test("a newer revision is applied (dates, quote, status, guest contact); no webhook echo to StayBook", async () => {
    hooks.clear();
    const res = await staybook.patch("/reservations/SB-TEST1001", {
      check_out: D(8),
      nights: 3,
      total_amount: 10500,
      booking_status: "ADMIN_CONFIRMED",
      guest: { phone: "09170000000" },
      updated_at: REV(2),
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ check_in: D(5), check_out: D(8), nights: 3, total_amount: 10500, booking_status: "ADMIN_CONFIRMED", sync_status: "UPDATED", room_number: "204", source_updated_at: REV(2) });
    expect((await deskView(ctx.main.frontdesk_reservation_id)).guest.phone).toBe("09170000000");
    await processOutbox();
    expect(hooks.events().filter((e) => e.external_reservation_id === "SB-TEST1001")).toEqual([]);
  });

  test("the same revision again is a no-op; an older revision is refused (409 STALE_UPDATE)", async () => {
    const same = await staybook.patch("/reservations/SB-TEST1001", { check_out: D(9), nights: 4, updated_at: REV(2) });
    expect(same.status).toBe(200);
    expect(same.data.check_out).toBe(D(8));

    const older = await staybook.patch("/reservations/SB-TEST1001", { check_out: D(6), nights: 1, updated_at: REV(1) });
    expect(older.status).toBe(409);
    expect(older.error.code).toBe("STALE_UPDATE");
    expect((await staybook.get("/reservations/SB-TEST1001")).data.check_out).toBe(D(8));
  });

  test("invalid updates → 422, reservation unchanged", async () => {
    const noRevision = await staybook.patch("/reservations/SB-TEST1001", { guests: 1 });
    expect(noRevision.status).toBe(422);
    expect(noRevision.error.details.updated_at).toBeDefined();
    const nights = await staybook.patch("/reservations/SB-TEST1001", { check_out: D(9), nights: 3, updated_at: REV(3) });
    expect(nights.status).toBe(422);
    expect(nights.error.details.nights).toBeDefined();
    const unmapped = await staybook.patch("/reservations/SB-TEST1001", { staybook_room_id: 9, updated_at: REV(3) });
    expect(unmapped.error.code).toBe("ROOM_NOT_MAPPED");
    expect((await staybook.get("/reservations/SB-TEST1001")).data).toMatchObject({ check_out: D(8), staybook_room_id: 1, source_updated_at: REV(2) });
  });

  test("a different StayBook room moves the booking to the newly mapped room", async () => {
    const res = await staybook.patch("/reservations/SB-TEST1001", { staybook_room_id: 5, nightly_rate: 5200, total_amount: 15600, updated_at: REV(4) });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ staybook_room_id: 5, frontdesk_room_id: ids["301"], room_number: "301", room_type: "Family", room_assignment: "AS_BOOKED", rate_matches_frontdesk: true });
    expect(await roomStatus("204")).toBe("AVAILABLE");
    expect(await roomStatus("301")).toBe("RESERVED");
  });

  test("an update that cannot be honoured (room taken) → 409, reservation unchanged", async () => {
    const res = await staybook.patch("/reservations/SB-TEST1001", { staybook_room_id: 2, check_in: D(20), check_out: D(22), nights: 2, updated_at: REV(5) });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_UNAVAILABLE");
    expect((await staybook.get("/reservations/SB-TEST1001")).data).toMatchObject({ room_number: "301", check_in: D(5), check_out: D(8), source_updated_at: REV(4) });
  });

  test("a room change made at the front desk is visible to StayBook and pushed by webhook", async () => {
    hooks.clear();
    const moved = await desk.put(`/reservations/${ctx.main.frontdesk_reservation_id}/room`, { roomId: ids["102"] });
    expect(moved.status).toBe(200);
    const res = await staybook.get("/reservations/SB-TEST1001");
    expect(res.data).toMatchObject({ staybook_room_id: 5, assigned_staybook_room_id: 3, frontdesk_room_id: ids["102"], room_assignment: "CHANGED_BY_FRONT_DESK" });
    await processOutbox();
    const [event] = hooks.events("ReservationUpdated");
    expect(event).toMatchObject({ external_reservation_id: "SB-TEST1001", booking_reference: "SB-TEST1001", room_number: "102", origin: "PMS" });
    expect(hooks.received.at(-1).signatureValid).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /reservations/{id}/cancel — cancellations", () => {
  test("cancel releases the room; repeating it is harmless; no webhook echo", async () => {
    hooks.clear();
    const res = await staybook.post("/reservations/SB-TEST1001/cancel", { reason: "Guest cancelled online", updated_at: REV(6) });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ frontdesk_status: "CANCELLED", booking_status: "CANCELLED", sync_status: "CANCELLED" });
    const avail = await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(8)}&guests=2`);
    expect(avail.data.rooms.map((r) => r.staybook_room_id)).toEqual(expect.arrayContaining([3]));

    const again = await staybook.post("/reservations/SB-TEST1001/cancel", { reason: "Retry" });
    expect(again.status).toBe(200);
    expect(again.data.frontdesk_status).toBe("CANCELLED");
    expect((await deskView(ctx.main.frontdesk_reservation_id)).cancellationReason).toBe("Guest cancelled online");

    const update = await staybook.patch("/reservations/SB-TEST1001", { guests: 1, updated_at: REV(7) });
    expect(update.status).toBe(409);
    expect(update.error.code).toBe("RESERVATION_NOT_MODIFIABLE");
    expect((await staybook.post("/reservations/SB-NOPE/cancel", {})).status).toBe(404);

    await processOutbox();
    expect(hooks.events().filter((e) => e.external_reservation_id === "SB-TEST1001")).toEqual([]);
  });

  test("after check-in: StayBook status updates are accepted, changes and cancellation are refused; StayBook is told of the check-in", async () => {
    hooks.clear();
    const created = await staybook.post("/reservations", booking(2001, { staybook_room_id: 2, check_in: D0, check_out: D(1), guests: 1, nights: 1, nightly_rate: 2500, total_amount: 2500 }));
    expect(created.status).toBe(201);
    const reservationId = created.data.frontdesk_reservation_id;
    const v = await desk.post("/verifications", { reservationId, idType: "PASSPORT", idNumberLast4: "4321", nameOnId: "Maria Santos", expiryDate: D(3650), photoMatches: true });
    expect(v.data.result).toBe("VERIFIED");
    expect((await desk.post("/check-ins", { reservationId })).status).toBe(201);

    const status = await staybook.patch("/reservations/SB-TEST2001", { booking_status: "ADMIN_CONFIRMED", updated_at: REV(10) });
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({ booking_status: "ADMIN_CONFIRMED", frontdesk_status: "CHECKED_IN" });
    const change = await staybook.patch("/reservations/SB-TEST2001", { check_out: D(2), nights: 2, updated_at: REV(11) });
    expect(change.status).toBe(409);
    expect(change.error.code).toBe("RESERVATION_NOT_MODIFIABLE");
    const cancel = await staybook.post("/reservations/SB-TEST2001/cancel", {});
    expect(cancel.status).toBe(409);
    expect(cancel.error.code).toBe("RESERVATION_NOT_MODIFIABLE");

    await processOutbox();
    expect(hooks.events("GuestCheckedIn")).toEqual([expect.objectContaining({ external_reservation_id: "SB-TEST2001", status: "CHECKED_IN", room_number: "101" })]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Authentication and authorization", () => {
  const url = (p) => `${app.base}/api/v1/integrations/staybook${p}`;

  test("missing or wrong key → 401; another system's key → 403; Bearer works", async () => {
    expect((await staybook.get(`/rooms/available?check_in=${D(5)}&check_out=${D(6)}&guests=1`, { apiKey: "" })).error.code).toBe("INVALID_API_KEY");
    expect((await staybook.post("/reservations", booking(3100), { apiKey: "wrong-key-0123456789" })).status).toBe(401);
    const pos = new IntegrationClient(app.base, "staybook", process.env.POS_API_KEY);
    const denied = await pos.post("/reservations", booking(3100));
    expect(denied.status).toBe(403);
    expect(denied.error.code).toBe("INSUFFICIENT_SCOPE");
    const hr = new IntegrationClient(app.base, "staybook", process.env.HR_API_KEY);
    expect((await hr.get("/reservations/SB-TEST4001")).status).toBe(403);

    const bearer = await fetch(url("/reservations/SB-TEST4001"), { headers: { Authorization: `Bearer ${process.env.BOOKING_API_KEY}` } });
    expect(bearer.status).toBe(200);
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST3100" } })).toBe(0);
  });

  test("a staff session cookie is not accepted; writes need an Idempotency-Key", async () => {
    const cookie = await fetch(url("/reservations/SB-TEST4001"), { headers: { Cookie: desk.cookie } });
    expect(cookie.status).toBe(401);
    const noKey = await staybook.post("/reservations", booking(3101), { idempotencyKey: "" });
    expect(noKey.status).toBe(400);
    expect(noKey.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("StayBook unavailable: webhooks are retried", () => {
  test("a failed delivery stays queued with backoff and is delivered once StayBook is back", async () => {
    const created = await staybook.post("/reservations", booking(3001, { staybook_room_id: 5, check_in: D(40), check_out: D(41), nights: 1, nightly_rate: 5200, total_amount: 5200 }));
    expect(created.status).toBe(201);
    hooks.clear();
    hooks.respondWith(503);
    expect((await desk.put(`/reservations/${created.data.frontdesk_reservation_id}/room`, { roomId: ids["204"] })).status).toBe(200);
    await processOutbox();

    const row = await IntegrationOutbox.findOne({ where: { target: "BOOKING", eventType: "ReservationUpdated" }, order: [["id", "DESC"]] });
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastResponseStatus: 503 });
    expect(row.payload.external_reservation_id).toBe("SB-TEST3001");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    hooks.respondWith(200);
    await row.update({ nextAttemptAt: new Date() });
    await processOutbox();
    expect((await row.reload()).status).toBe("SENT");
    const delivered = hooks.events("ReservationUpdated");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ external_reservation_id: "SB-TEST3001", room_number: "204", event_id: row.payload.event_id });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Reference StayBook client (docs/staybook/frontdeskClient.js)", () => {
  const confirmed = (n, extra = {}) => ({
    // Shape of StayBook's POST /api/bookings/confirm response (OnlineBooking API documentation) + its revision time.
    reservation_id: n,
    reference: `SB-TEST${n}`,
    room_id: 1,
    room_number: "101",
    room_type: "Deluxe Room",
    first_name: "Ana",
    last_name: "Reyes",
    email: "ana@example.com",
    phone: "09181234567",
    address: "Calapan City",
    check_in: D(60),
    check_out: D(61),
    guests: 2,
    nights: 1,
    nightly_rate: "3500.00",
    total_amount: "3500.00",
    status: "LOCAL_CONFIRMED",
    integration_status: "NOT_CONNECTED",
    payment_method: "VISA",
    card_last4: "4242",
    updated_at: REV(20),
    ...extra,
  });
  const noSleep = [];
  const sleep = async (ms) => noSleep.push(ms);
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  test("maps StayBook's booking to the contract and never forwards address or payment details", () => {
    const payload = toFrontdeskReservation(confirmed(123), { hotelId: 1 });
    expect(payload).toEqual({
      source_system: "STAYBOOK",
      source_booking_id: "123",
      booking_reference: "SB-TEST123",
      hotel_id: "1",
      staybook_room_id: "1",
      guest: { first_name: "Ana", last_name: "Reyes", email: "ana@example.com", phone: "09181234567" },
      check_in: D(60),
      check_out: D(61),
      guests: 2,
      nights: 1,
      nightly_rate: 3500,
      total_amount: 3500,
      currency: "PHP",
      booking_status: "LOCAL_CONFIRMED",
      payment_mode: "SIMULATED",
      updated_at: REV(20),
    });
    expect(() => toFrontdeskReservation(confirmed(124, { updated_at: undefined }))).toThrow(/updated_at/);
  });

  test("idempotency keys are deterministic per operation and revision, and always valid", () => {
    expect(idempotencyKey("create", "SB-1", REV(1))).toBe(idempotencyKey("create", "SB-1", REV(1)));
    expect(idempotencyKey("create", "SB-1", REV(1))).not.toBe(idempotencyKey("create", "SB-1", REV(1), 2));
    expect(idempotencyKey("update", "SB-1", REV(1))).not.toBe(idempotencyKey("update", "SB-1", REV(2)));
    expect(idempotencyKey("create", "SB-".padEnd(100, "X"), REV(1))).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });

  test("network errors and 5xx are retried with backoff, same key and same body; 429 honours Retry-After", async () => {
    const seen = [];
    const answers = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => json(503, { success: false, error: { code: "INTERNAL", message: "x" } }),
      () => json(429, { success: false, error: { code: "RATE_LIMITED", message: "x" } }, { "Retry-After": "7" }),
      () => json(201, { success: true, data: { frontdesk_reservation_id: 99 } }),
    ];
    const client = createFrontdeskClient({ baseUrl: "http://frontdesk.test/", apiKey: "k", sleep, retryDelayMs: 100, fetchImpl: async (u, init) => (seen.push(init), answers[seen.length - 1]()) });
    noSleep.length = 0;
    const result = await client.createReservation(toFrontdeskReservation(confirmed(125), { hotelId: 1 }));
    expect(result).toMatchObject({ ok: true, status: 201, attempts: 4 });
    expect(syncOutcome(result)).toEqual({ sync_status: "SYNCED", frontdesk_reservation_id: 99, error_code: null });
    expect(new Set(seen.map((s) => s.headers["Idempotency-Key"])).size).toBe(1);
    expect(new Set(seen.map((s) => s.body)).size).toBe(1);
    expect(noSleep).toEqual([100, 200, 7000]);
  });

  test("business refusals are not retried (REJECTED); a timeout is retried", async () => {
    let calls = 0;
    const refuse = createFrontdeskClient({ baseUrl: "http://frontdesk.test", apiKey: "k", sleep, fetchImpl: async () => (calls++, json(422, { success: false, error: { code: "ROOM_NOT_MAPPED", message: "x" } })) });
    const result = await refuse.createReservation(toFrontdeskReservation(confirmed(126), { hotelId: 1 }));
    expect(calls).toBe(1);
    expect(syncOutcome(result)).toEqual({ sync_status: "REJECTED", frontdesk_reservation_id: null, error_code: "ROOM_NOT_MAPPED" });

    const hang = (u, { signal }) =>
      new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const slow = createFrontdeskClient({ baseUrl: "http://frontdesk.test", apiKey: "k", sleep, timeoutMs: 20, maxAttempts: 2, fetchImpl: hang });
    const timedOut = await slow.getReservation("SB-1");
    expect(timedOut).toMatchObject({ ok: false, attempts: 2, retryable: true, error: { code: "TIMEOUT" } });
  });

  test("Frontdesk unavailable → PENDING_RETRY; the queued retry later synchronises with the same key", async () => {
    const payload = toFrontdeskReservation(confirmed(6001), { hotelId: 1 });
    const down = createFrontdeskClient({ baseUrl: "http://127.0.0.1:1", apiKey: process.env.BOOKING_API_KEY, sleep, maxAttempts: 3 });
    const failed = await down.createReservation(payload);
    expect(failed).toMatchObject({ ok: false, status: 0, attempts: 3, error: { code: "NETWORK_ERROR" } });
    expect(syncOutcome(failed).sync_status).toBe("PENDING_RETRY");

    const up = createFrontdeskClient({ baseUrl: app.base, apiKey: process.env.BOOKING_API_KEY, sleep });
    const synced = await up.createReservation(payload);
    expect(synced.idempotencyKey).toBe(failed.idempotencyKey);
    expect(syncOutcome(synced)).toMatchObject({ sync_status: "SYNCED", frontdesk_reservation_id: expect.any(Number) });
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST6001" } })).toBe(1);
  });

  test("answer lost after the Frontdesk saved the booking → the retry is replayed, not duplicated", async () => {
    let first = true;
    const lossy = async (u, init) => {
      const res = await fetch(u, init);
      if (first) {
        first = false;
        throw new TypeError("socket hang up");
      }
      return res;
    };
    const client = createFrontdeskClient({ baseUrl: app.base, apiKey: process.env.BOOKING_API_KEY, sleep, fetchImpl: lossy });
    const result = await client.createReservation(toFrontdeskReservation(confirmed(7001, { check_in: D(70), check_out: D(71) }), { hotelId: 1 }));
    expect(result).toMatchObject({ ok: true, status: 201, attempts: 2, replayed: true });
    expect(await Reservation.count({ where: { externalReservationId: "SB-TEST7001" } })).toBe(1);
  });

  test("rejected (unmapped room) → fixed by the administrator → retried with a new generation → SYNCED", async () => {
    const client = createFrontdeskClient({ baseUrl: app.base, apiKey: process.env.BOOKING_API_KEY, sleep });
    const payload = toFrontdeskReservation(confirmed(5001, { room_id: 9, check_in: D(50), check_out: D(51) }), { hotelId: 1 });
    const rejected = await client.createReservation(payload);
    expect(syncOutcome(rejected)).toMatchObject({ sync_status: "REJECTED", error_code: "ROOM_NOT_MAPPED" });
    // The same key only replays the stored refusal.
    const replay = await client.createReservation(payload);
    expect(replay).toMatchObject({ replayed: true, status: 422 });

    // The administrator maps StayBook room 9 (instead of 3) to room 102.
    expect((await admin.put("/admin/staybook/room-mappings/9", { roomId: ids["102"], replace: true })).status).toBe(200);
    const retried = await client.createReservation(payload, { generation: 2 });
    expect(retried.status).toBe(201);
    expect(retried.data).toMatchObject({ staybook_room_id: 9, room_number: "102" });
    // A later re-send (e.g. a reconciliation job) recognises the existing reservation.
    const duplicate = await client.createReservation(payload, { generation: 3 });
    expect(syncOutcome(duplicate)).toEqual({ sync_status: "SYNCED", frontdesk_reservation_id: retried.data.frontdesk_reservation_id, error_code: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Local Frontdesk reservations are unaffected", () => {
  test("front-desk reservations work as before: no StayBook link, no webhooks to StayBook", async () => {
    hooks.clear();
    const links = await ExternalBooking.count();
    const local = await desk.post("/reservations", { guest: { firstName: "Local", lastName: "Guest" }, roomType: "Standard", checkInDate: D(80), checkOutDate: D(82), numGuests: 2 });
    expect(local.status).toBe(201);
    expect(local.data).toMatchObject({ source: "FRONT_DESK", externalReservationId: null, status: "CONFIRMED" });
    expect(await ExternalBooking.count()).toBe(links);
    expect((await staybook.get(`/reservations/${local.data.id}`)).status).toBe(404);
    await processOutbox();
    expect(hooks.events()).toEqual([]);
  });

  test("the type-based Booking API (/booking) keeps working alongside /staybook", async () => {
    const types = await new IntegrationClient(app.base, "booking", process.env.BOOKING_API_KEY).get("/room-types");
    const deluxe = types.data.find((t) => t.room_type === "Deluxe").room_type_id;
    const res = await new IntegrationClient(app.base, "booking", process.env.BOOKING_API_KEY).post("/reservations", {
      external_reservation_id: "BOOK-LEGACY-1",
      guest: { first_name: "Legacy", last_name: "Client" },
      room_type_id: deluxe,
      check_in_date: D(90),
      check_out_date: D(91),
      number_of_guests: 1,
    });
    expect(res.status).toBe(201);
    expect((await staybook.get("/reservations/BOOK-LEGACY-1")).status).toBe(404);
  });
});
