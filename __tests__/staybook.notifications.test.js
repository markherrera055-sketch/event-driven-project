/**
 * Online Reservations: staff notifications for StayBook bookings, room
 * protection of online bookings, and the staff / admin views.
 *
 * StayBook is simulated (IntegrationClient plays StayBook's backend, a local
 * receiver plays its webhook endpoint). Every request hits the real app and
 * the FrontDesk_test database.
 */
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, startReceiver } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { Room, Reservation, ExternalBooking, StaffNotification, IntegrationOutbox } from "../models/index.js";
import { today, addDays } from "../utils/dates.js";

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

/** A StayBook booking as StayBook sends it (default: StayBook room 1 → Frontdesk 204 Deluxe). */
const booking = (n, extra = {}) => ({
  source_system: "STAYBOOK",
  source_booking_id: String(n),
  booking_reference: `SB-NOTE${n}`,
  hotel_id: 1,
  staybook_room_id: 1,
  guest: { first_name: "Maria", last_name: "Santos", email: "maria@example.com", phone: "09171234567" },
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

const count = (where) => StaffNotification.count({ where });
const walkIn = (roomNumber, checkInDate, checkOutDate, extra = {}) =>
  desk.post("/reservations", { guest: { firstName: "Walk", lastName: "In" }, roomId: ids[roomNumber], checkInDate, checkOutDate, numGuests: 1, ...extra });

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  staybook = new IntegrationClient(app.base, "staybook", process.env.BOOKING_API_KEY);
  hooks = await startReceiver("BOOKING", process.env.BOOKING_WEBHOOK_SECRET);
  for (const r of await Room.findAll()) ids[r.roomNumber] = r.id;
  // StayBook 1 → 204 (Deluxe), 2 → 101, 3 → 102, 5 → 301 (Family). StayBook 9 stays unmapped.
  for (const [sb, room] of [["1", "204"], ["2", "101"], ["3", "102"], ["5", "301"]]) {
    expect((await admin.put(`/admin/staybook/room-mappings/${sb}`, { roomId: ids[room] })).status).toBe(200);
  }
});
afterAll(async () => {
  await hooks?.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("New StayBook booking → notification", () => {
  test("a received booking creates exactly one 'New online reservation' notification with guest, room and reference", async () => {
    const res = await staybook.post("/reservations", booking(1));
    expect(res.status).toBe(201);
    ctx.first = res.data;

    const list = await desk.get("/notifications");
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);
    const n = list.data[0];
    expect(n).toMatchObject({
      category: "ONLINE_RESERVATION_NEW",
      problem: false,
      reservationId: res.data.frontdesk_reservation_id,
      bookingReference: "SB-NOTE1",
      roomNumber: "204",
      guestName: "Maria Santos",
      read: false,
    });
    expect(n.title).toContain("Room 204");
    expect(n.message).toContain("Maria Santos");
    expect(n.message).toContain("SB-NOTE1");
    expect(n.message).toContain(`${D(5)} → ${D(7)}`);
    // No guest contact details in notifications.
    expect(JSON.stringify(list.body)).not.toMatch(/maria@example\.com|09171234567/);
  });

  test("visible to every authorised staff role; not to anonymous users; writes need CSRF", async () => {
    expect((await admin.get("/notifications")).data).toHaveLength(1);
    const anonymous = new StaffClient(app.base);
    expect((await anonymous.get("/notifications")).status).toBe(401);
    expect((await anonymous.get("/notifications/summary")).status).toBe(401);
    expect((await anonymous.get("/online-reservations")).status).toBe(401);
    const noCsrf = await desk.api("POST", "/notifications/read-all", {}, { csrf: false });
    expect(noCsrf.status).toBe(403);
  });

  test("unread count is per staff member; marking read is idempotent", async () => {
    const before = await desk.get("/notifications/summary");
    expect(before.data).toMatchObject({ unread: 1, problems: 0, byCategory: { ONLINE_RESERVATION_NEW: 1 } });
    expect(before.data.latestUnread).toMatchObject({ bookingReference: "SB-NOTE1", roomNumber: "204", guestName: "Maria Santos" });

    const id = before.data.latestUnread.id;
    expect((await desk.post(`/notifications/${id}/read`)).status).toBe(200);
    expect((await desk.post(`/notifications/${id}/read`)).status).toBe(200);
    expect((await desk.get("/notifications/summary")).data.unread).toBe(0);
    expect((await desk.get("/notifications")).data[0].read).toBe(true);
    expect((await desk.get("/notifications?unread=true")).data).toHaveLength(0);
    // The administrator has not read it yet.
    expect((await admin.get("/notifications/summary")).data.unread).toBe(1);
    expect((await desk.post("/notifications/999999/read")).status).toBe(404);
  });

  test("mark all read stops at the newest notification the user has seen", async () => {
    const seen = (await admin.get("/notifications/summary")).data.latestUnread.id;
    const second = await staybook.post("/reservations", booking(2, { staybook_room_id: 2, check_in: D(5), check_out: D(6), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 }));
    expect(second.status).toBe(201);
    expect((await admin.post("/notifications/read-all", { upToId: seen })).status).toBe(200);
    const after = await admin.get("/notifications/summary");
    expect(after.data.unread).toBe(1);
    expect(after.data.latestUnread.bookingReference).toBe("SB-NOTE2");
    // Opening a reservation's details marks its notifications read.
    await admin.post("/notifications/read-all", { reservationId: second.data.frontdesk_reservation_id });
    expect((await admin.get("/notifications/summary")).data.unread).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Online Reservations page data", () => {
  test("lists StayBook bookings with every column the page shows", async () => {
    const res = await desk.get("/online-reservations");
    expect(res.status).toBe(200);
    const row = res.data.find((r) => r.bookingReference === "SB-NOTE1");
    expect(row).toMatchObject({
      id: ctx.first.frontdesk_reservation_id,
      reservationCode: ctx.first.reservation_code,
      bookingReference: "SB-NOTE1",
      guestName: "Maria Santos",
      room: { roomNumber: "204", roomType: "Deluxe" },
      roomType: "Deluxe",
      checkInDate: D(5),
      checkOutDate: D(7),
      numGuests: 2,
      status: "CONFIRMED",
      bookingStatus: "LOCAL_CONFIRMED",
      sync: { inbound: "ACKNOWLEDGED", health: "OK" },
      quote: { nightlyRate: 3500, totalAmount: 7000, currency: "PHP" },
    });
    expect(row.receivedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/maria@example\.com|09171234567/);
  });

  test("search and filters: guest, reference, room, check-in, check-out, status", async () => {
    const refs = async (q) => (await desk.get(`/online-reservations?${q}`)).data.map((r) => r.bookingReference).sort();
    expect(await refs("guest=maria%20san")).toEqual(["SB-NOTE1", "SB-NOTE2"]);
    expect(await refs("guest=nobody")).toEqual([]);
    expect(await refs("reference=NOTE2")).toEqual(["SB-NOTE2"]);
    expect(await refs(`reference=${ctx.first.reservation_code}`)).toEqual(["SB-NOTE1"]);
    expect(await refs("room=204")).toEqual(["SB-NOTE1"]);
    expect(await refs(`checkIn=${D(5)}`)).toEqual(["SB-NOTE1", "SB-NOTE2"]);
    expect(await refs(`checkOut=${D(6)}`)).toEqual(["SB-NOTE2"]);
    expect(await refs("status=CONFIRMED")).toEqual(["SB-NOTE1", "SB-NOTE2"]);
    expect(await refs("status=CANCELLED")).toEqual([]);
    expect((await desk.get("/online-reservations?checkIn=not-a-date")).status).toBe(422);
  });

  test("reservation details include the booking history", async () => {
    const res = await desk.get(`/online-reservations/${ctx.first.frontdesk_reservation_id}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ bookingReference: "SB-NOTE1", sourceUpdatedAt: REV(1) });
    expect(res.data.history.events[0]).toMatchObject({ type: "ReservationCreated", origin: "STAYBOOK", roomNumber: "204" });
    expect(res.data.history.notifications.map((n) => n.category)).toEqual(["ONLINE_RESERVATION_NEW"]);
  });

  test("front-desk reservations are not online reservations (404); the page renders for staff", async () => {
    const local = await walkIn("102", D(50), D(51));
    expect(local.status).toBe(201);
    expect((await desk.get(`/online-reservations/${local.data.id}`)).status).toBe(404);
    const page = await desk.raw("GET", "/front-desk/online-reservations");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Online reservations");
    expect(html).toContain("data-online-count");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Room protection: online bookings hold their room for their dates only", () => {
  beforeAll(async () => {
    // Room 204 reserved online from D(30) to D(33).
    const res = await staybook.post("/reservations", booking(10, { check_in: D(30), check_out: D(33), nights: 3, total_amount: 10500 }));
    expect(res.status).toBe(201);
    ctx.protected = res.data;
  });

  test("a walk-in cannot take the room for overlapping dates; the warning names the online booking", async () => {
    for (const [from, to] of [[D(31), D(32)], [D(29), D(31)], [D(32), D(34)], [D(29), D(35)]]) {
      const res = await walkIn("204", from, to);
      expect(res.status).toBe(409);
      expect(res.error.code).toBe("ROOM_UNAVAILABLE");
      expect(res.error.message).toContain("online StayBook guest");
      expect(res.error.message).toContain("SB-NOTE10");
      expect(res.error.details.protected_by).toEqual({
        source_system: "STAYBOOK",
        booking_reference: "SB-NOTE10",
        reservation_code: ctx.protected.reservation_code,
        room_number: "204",
        check_in: D(30),
        check_out: D(33),
      });
    }
    // The only Deluxe room is held, so a booking by type is refused as well.
    const byType = await desk.post("/reservations", { guest: { firstName: "Walk", lastName: "In" }, roomType: "Deluxe", checkInDate: D(31), checkOutDate: D(32), numGuests: 1 });
    expect(byType.status).toBe(409);
    expect(byType.error.code).toBe("NO_AVAILABILITY");
  });

  test("the room stays bookable for stays that do not overlap (not permanently blocked)", async () => {
    const before = await walkIn("204", D(28), D(30)); // leaves on the online guest's arrival day
    expect(before.status).toBe(201);
    const after = await walkIn("204", D(33), D(35)); // arrives on the online guest's departure day
    expect(after.status).toBe(201);
    ctx.walkInsAround = [before.data.id, after.data.id];
    expect(await Reservation.count({ where: { roomId: ids["204"], status: "CONFIRMED" } })).toBe(4);
  });

  test("staff cannot assign the protected room to an arriving guest; the picker hides it only for overlapping dates", async () => {
    const overlapping = await walkIn("101", D(31), D(32));
    expect(overlapping.status).toBe(201);
    const choices = await desk.get(`/reservations/${overlapping.data.id}/assignable-rooms?allTypes=true`);
    expect(choices.data.map((r) => r.roomNumber)).not.toContain("204");
    const assign = await desk.put(`/reservations/${overlapping.data.id}/room`, { roomId: ids["204"] });
    expect(assign.status).toBe(409);
    expect(assign.error.code).toBe("ROOM_UNAVAILABLE");
    expect(assign.error.message).toContain("SB-NOTE10");
    expect((await Reservation.findByPk(overlapping.data.id)).roomId).toBe(ids["101"]);

    const later = await walkIn("101", D(36), D(37));
    const laterChoices = await desk.get(`/reservations/${later.data.id}/assignable-rooms?allTypes=true`);
    expect(laterChoices.data.map((r) => r.roomNumber)).toContain("204");
  });

  test("room holds endpoint: the online hold for overlapping ranges, nothing for adjacent ones", async () => {
    const holds = await desk.get(`/online-reservations/holds?checkIn=${D(31)}&checkOut=${D(32)}`);
    expect(holds.status).toBe(200);
    expect(holds.data).toEqual([
      expect.objectContaining({ roomNumber: "204", bookingReference: "SB-NOTE10", reservationCode: ctx.protected.reservation_code, checkInDate: D(30), checkOutDate: D(33), guestName: "Maria Santos" }),
    ]);
    expect((await desk.get(`/online-reservations/holds?checkIn=${D(28)}&checkOut=${D(30)}`)).data).toEqual([]);
    expect((await desk.get(`/online-reservations/holds?checkIn=${D(31)}&checkOut=${D(32)}&excludeReservationId=${ctx.protected.frontdesk_reservation_id}`)).data).toEqual([]);
    expect((await desk.get(`/online-reservations/holds?checkIn=${D(32)}&checkOut=${D(31)}`)).status).toBe(422);
  });

  test("StayBook itself cannot double-book the room either → Room Conflict Warning for staff", async () => {
    const res = await staybook.post("/reservations", booking(11, { check_in: D(32), check_out: D(34), nights: 2 }), { key: "staybook:create:SB-NOTE11:1" });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_UNAVAILABLE");
    expect(await ExternalBooking.count({ where: { bookingReference: "SB-NOTE11" } })).toBe(0);
    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-NOTE11" } });
    expect(n).toMatchObject({ category: "ROOM_CONFLICT", roomNumber: "204", guestName: "Maria Santos", reservationId: null });
    expect(n.details).toMatchObject({ operation: "create", error_code: "ROOM_UNAVAILABLE", check_in: D(32), check_out: D(34) });
    expect(n.details.conflict_with).toMatchObject({ booking_reference: "SB-NOTE10" });
    expect((await desk.get("/notifications/summary")).data.problems).toBeGreaterThanOrEqual(1);

    // StayBook retries with the same key: the refusal is replayed, no second notification.
    const retry = await staybook.post("/reservations", booking(11, { check_in: D(32), check_out: D(34), nights: 2 }), { key: "staybook:create:SB-NOTE11:1" });
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await count({ bookingReference: "SB-NOTE11" })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Updated reservation dates", () => {
  test("new dates are applied, the old nights are released, the new ones protected, staff notified once", async () => {
    // D(30)–D(33) → D(40)–D(42)
    const res = await staybook.patch("/reservations/SB-NOTE10", { check_in: D(40), check_out: D(42), nights: 2, total_amount: 7000, updated_at: REV(2) });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ check_in: D(40), check_out: D(42), sync_status: "UPDATED" });

    const n = await StaffNotification.findAll({ where: { bookingReference: "SB-NOTE10", category: "ONLINE_RESERVATION_UPDATED" } });
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain(`check-in ${D(40)}`);
    expect(n[0].message).toContain(`check-out ${D(42)}`);
    expect(n[0].details.changes).toEqual([`check-in ${D(40)}`, `check-out ${D(42)}`, "quoted price"]);

    expect((await walkIn("204", D(31), D(32))).status).toBe(201); // old dates: free again
    const blocked = await walkIn("204", D(41), D(43)); // new dates: protected
    expect(blocked.status).toBe(409);
    expect(blocked.error.message).toContain("SB-NOTE10");

    const row = (await desk.get(`/online-reservations/${ctx.protected.frontdesk_reservation_id}`)).data;
    expect(row).toMatchObject({ checkInDate: D(40), checkOutDate: D(42), sync: { inbound: "UPDATED" } });
    expect(row.history.events.map((e) => [e.type, e.origin])).toEqual([["ReservationCreated", "STAYBOOK"], ["ReservationUpdated", "STAYBOOK"]]);
  });

  test("the same revision delivered again (new key) or replayed (same key) does not notify again", async () => {
    const body = { check_in: D(40), check_out: D(42), nights: 2, total_amount: 7000, updated_at: REV(2) };
    expect((await staybook.patch("/reservations/SB-NOTE10", body)).status).toBe(200);
    const once = await staybook.patch("/reservations/SB-NOTE10", { ...body, booking_status: "ADMIN_CONFIRMED", updated_at: REV(3) }, { key: "staybook:update:SB-NOTE10:3" });
    expect(once.status).toBe(200);
    const replay = await staybook.patch("/reservations/SB-NOTE10", { ...body, booking_status: "ADMIN_CONFIRMED", updated_at: REV(3) }, { key: "staybook:update:SB-NOTE10:3" });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const updates = await StaffNotification.findAll({ where: { bookingReference: "SB-NOTE10", category: "ONLINE_RESERVATION_UPDATED" }, order: [["id", "ASC"]] });
    expect(updates).toHaveLength(2);
    expect(updates[1].message).toContain("StayBook status ADMIN_CONFIRMED");
  });

  test("an older revision (STALE_UPDATE) is not a sync failure", async () => {
    const stale = await staybook.patch("/reservations/SB-NOTE10", { guests: 1, updated_at: REV(1) });
    expect(stale.status).toBe(409);
    expect(stale.error.code).toBe("STALE_UPDATE");
    expect(await count({ bookingReference: "SB-NOTE10", category: ["SYNC_FAILED", "ROOM_CONFLICT"] })).toBe(0);
  });

  test("a change onto nights already taken at the desk is refused → Room Conflict Warning, booking unchanged", async () => {
    // Walk-in on 204 for D(33)–D(35) exists (see room protection).
    const res = await staybook.patch("/reservations/SB-NOTE10", { check_in: D(34), check_out: D(36), nights: 2, updated_at: REV(4) });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_UNAVAILABLE");
    const r = await Reservation.findByPk(ctx.protected.frontdesk_reservation_id);
    expect([r.checkInDate, r.checkOutDate]).toEqual([D(40), D(42)]);
    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-NOTE10", category: "ROOM_CONFLICT" } });
    expect(n).toMatchObject({ reservationId: r.id, roomNumber: "204" });
    expect(n.details).toMatchObject({ operation: "update", check_in: D(34), check_out: D(36) });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Cancelled reservation → room released, history kept", () => {
  test("cancellation notifies staff once, keeps the records, and frees the room for those dates", async () => {
    const res = await staybook.post("/reservations/SB-NOTE10/cancel", { reason: "Guest cancelled online", updated_at: REV(5) });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ frontdesk_status: "CANCELLED", sync_status: "CANCELLED" });

    const n = await StaffNotification.findAll({ where: { bookingReference: "SB-NOTE10", category: "ONLINE_RESERVATION_CANCELLED" } });
    expect(n).toHaveLength(1);
    expect(n[0].message).toContain("Room 204 is released");
    expect(n[0].details.reason).toBe("Guest cancelled online");

    // History: the reservation and the StayBook link are kept, as CANCELLED.
    const r = await Reservation.findByPk(ctx.protected.frontdesk_reservation_id);
    expect(r).toMatchObject({ status: "CANCELLED", roomId: ids["204"] });
    expect(await ExternalBooking.count({ where: { bookingReference: "SB-NOTE10" } })).toBe(1);
    expect((await desk.get("/online-reservations?status=CANCELLED")).data.map((x) => x.bookingReference)).toContain("SB-NOTE10");

    // Released: a walk-in can now take room 204 on those nights.
    expect((await walkIn("204", D(40), D(42))).status).toBe(201);
    expect((await desk.get(`/online-reservations/holds?checkIn=${D(40)}&checkOut=${D(42)}`)).data).toEqual([]);

    // Cancelling again: same answer, no second notification.
    expect((await staybook.post("/reservations/SB-NOTE10/cancel", { updated_at: REV(5) })).status).toBe(200);
    expect(await count({ bookingReference: "SB-NOTE10", category: "ONLINE_RESERVATION_CANCELLED" })).toBe(1);
  });

  test("a front-desk cancellation of an online booking is not announced as a StayBook cancellation", async () => {
    const res = await staybook.post("/reservations", booking(12, { staybook_room_id: 3, check_in: D(60), check_out: D(61), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 }));
    expect(res.status).toBe(201);
    // The desk API has no cancel endpoint for staff yet; cancel through the core service as the desk would.
    const { cancelReservation } = await import("../services/reservationService.js");
    await cancelReservation({ id: res.data.frontdesk_reservation_id }, "Guest phoned the hotel");
    expect(await count({ bookingReference: "SB-NOTE12", category: "ONLINE_RESERVATION_CANCELLED" })).toBe(0);
    // StayBook later confirms the cancellation: now staff are told (once).
    expect((await staybook.post("/reservations/SB-NOTE12/cancel", { updated_at: REV(6) })).status).toBe(200);
    expect(await count({ bookingReference: "SB-NOTE12", category: "ONLINE_RESERVATION_CANCELLED" })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Failed synchronisation → notification", () => {
  test("unmapped StayBook room → SYNC_FAILED notification, nothing booked", async () => {
    const res = await staybook.post("/reservations", booking(20, { staybook_room_id: 9 }));
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("ROOM_NOT_MAPPED");
    expect(await Reservation.count({ where: { externalReservationId: "SB-NOTE20" } })).toBe(0);
    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-NOTE20" } });
    expect(n).toMatchObject({ category: "SYNC_FAILED", guestName: "Maria Santos", roomNumber: null, reservationId: null });
    expect(n.message).toContain("StayBook room 9");
    expect(n.details).toMatchObject({ operation: "create", http_status: 422, error_code: "ROOM_NOT_MAPPED" });
    expect(JSON.stringify(n.toJSON())).not.toMatch(/maria@example\.com|09171234567/);
  });

  test("invalid data → SYNC_FAILED with the field errors", async () => {
    const res = await staybook.post("/reservations", booking(21, { nights: 5 }));
    expect(res.status).toBe(422);
    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-NOTE21" } });
    expect(n.category).toBe("SYNC_FAILED");
    expect(n.details.field_errors).toHaveProperty("nights");
  });

  test("an update for a booking the Frontdesk does not have → SYNC_FAILED", async () => {
    const res = await staybook.patch("/reservations/SB-UNKNOWN99", { guests: 1, updated_at: REV(1) });
    expect(res.status).toBe(404);
    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-UNKNOWN99" } });
    expect(n).toMatchObject({ category: "SYNC_FAILED" });
    expect(n.details.error_code).toBe("RESERVATION_NOT_FOUND");
  });

  test("a webhook to StayBook that fails on every attempt → SYNC_FAILED, shown on the page and in the admin console", async () => {
    const res = await staybook.post("/reservations", booking(22, { staybook_room_id: 5, check_in: D(70), check_out: D(71), nights: 1, nightly_rate: 5200, total_amount: 5200 }));
    expect(res.status).toBe(201);
    const reservationId = res.data.frontdesk_reservation_id;
    await processOutbox(); // deliver anything pending while StayBook is still up
    hooks.respondWith(503);
    expect((await desk.put(`/reservations/${reservationId}/room`, { roomId: ids["102"] })).status).toBe(200);
    const row = await IntegrationOutbox.findOne({ where: { target: "BOOKING", eventType: "ReservationUpdated" }, order: [["id", "DESC"]] });
    expect(row.payload.external_reservation_id).toBe("SB-NOTE22");
    for (let i = 0; i < Number(process.env.INTEGRATION_OUTBOX_MAX_ATTEMPTS); i += 1) {
      await row.update({ nextAttemptAt: new Date() });
      await processOutbox();
    }
    expect((await row.reload()).status).toBe("FAILED");
    hooks.respondWith(200);

    const n = await StaffNotification.findOne({ where: { bookingReference: "SB-NOTE22", category: "SYNC_FAILED" } });
    expect(n).toMatchObject({ reservationId, roomNumber: "102" });
    expect(n.details).toMatchObject({ operation: "webhook", outbox_id: row.id, event: "ReservationUpdated", attempts: 3 });

    const page = (await desk.get("/online-reservations?reference=SB-NOTE22")).data[0];
    expect(page.sync).toMatchObject({ health: "WEBHOOK_FAILED", outbound: { status: "FAILED", event: "ReservationUpdated" } });
    expect(page).toMatchObject({ roomChangedByFrontDesk: true, bookedRoomNumber: "301", room: { roomNumber: "102" } });

    expect((await desk.get("/admin/staybook/sync-issues")).status).toBe(403);
    const issues = await admin.get("/admin/staybook/sync-issues");
    expect(issues.status).toBe(200);
    expect(issues.data.failedWebhooks).toEqual([expect.objectContaining({ id: row.id, bookingReference: "SB-NOTE22", reservationId })]);
    expect(issues.data.refusedRequests.map((r) => r.code)).toEqual(expect.arrayContaining(["ROOM_NOT_MAPPED", "ROOM_UNAVAILABLE", "VALIDATION_ERROR"]));
  });

  test("problem notifications are listed for every staff member", async () => {
    const problems = await desk.get("/notifications?problems=true&limit=100");
    expect(problems.data.every((n) => n.problem)).toBe(true);
    expect(problems.data.map((n) => n.bookingReference)).toEqual(expect.arrayContaining(["SB-NOTE11", "SB-NOTE20", "SB-NOTE21", "SB-NOTE22"]));
    expect((await admin.get("/notifications?problems=true&limit=100")).data).toHaveLength(problems.data.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Duplicate webhook delivery", () => {
  test("same key → replayed; new key → DUPLICATE_RESERVATION; neither notifies again", async () => {
    const first = await staybook.post("/reservations", booking(30, { staybook_room_id: 3, check_in: D(80), check_out: D(81), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 }), { key: "staybook:create:SB-NOTE30:1" });
    expect(first.status).toBe(201);
    const replay = await staybook.post("/reservations", booking(30, { staybook_room_id: 3, check_in: D(80), check_out: D(81), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 }), { key: "staybook:create:SB-NOTE30:1" });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const again = await staybook.post("/reservations", booking(30, { staybook_room_id: 3, check_in: D(80), check_out: D(81), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 }));
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("DUPLICATE_RESERVATION");
    expect(await Reservation.count({ where: { externalReservationId: "SB-NOTE30" } })).toBe(1);
    expect(await count({ bookingReference: "SB-NOTE30" })).toBe(1);
  });

  test("simultaneous deliveries of one booking → one reservation, one notification", async () => {
    const body = booking(31, { staybook_room_id: 2, check_in: D(82), check_out: D(83), nights: 1, guests: 1, nightly_rate: 2500, total_amount: 2500 });
    const results = await Promise.all([1, 2, 3, 4].map(() => staybook.post("/reservations", body)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.error.code === "DUPLICATE_RESERVATION")).toBe(true);
    expect(await Reservation.count({ where: { externalReservationId: "SB-NOTE31" } })).toBe(1);
    expect(await count({ bookingReference: "SB-NOTE31" })).toBe(1);
    expect(await count({ bookingReference: "SB-NOTE31", category: "ONLINE_RESERVATION_NEW" })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Existing front-desk workflows are unaffected", () => {
  test("walk-in by type, room assignment and check-in work and create no notifications", async () => {
    const before = await StaffNotification.count();
    const r = await desk.post("/reservations", { guest: { firstName: "Juan", lastName: "Cruz" }, roomType: "Standard", checkInDate: D0, checkOutDate: D(1), numGuests: 1 });
    expect(r.status).toBe(201);
    expect(r.data.room).toBeNull();
    const choices = await desk.get(`/reservations/${r.data.id}/assignable-rooms`);
    expect(choices.data.length).toBeGreaterThan(0);
    const assigned = await desk.put(`/reservations/${r.data.id}/room`, { roomId: choices.data[0].id });
    expect(assigned.status).toBe(200);
    const v = await desk.post("/verifications", { reservationId: r.data.id, idType: "PASSPORT", idNumberLast4: "1234", nameOnId: "Juan Cruz", expiryDate: D(400), photoMatches: true });
    expect(v.data.result).toBe("VERIFIED");
    expect((await desk.post("/check-ins", { reservationId: r.data.id })).status).toBe(201);
    expect(await StaffNotification.count()).toBe(before);
  });

  test("a walk-in clashing with another walk-in keeps the original message", async () => {
    const a = await walkIn("102", D(90), D(92));
    expect(a.status).toBe(201);
    const b = await walkIn("102", D(91), D(93));
    expect(b.status).toBe(409);
    expect(b.error.code).toBe("ROOM_UNAVAILABLE");
    expect(b.error.message).toBe(`Room 102 is already booked for part of these dates (${a.data.reservationCode}).`);
    expect(b.error.details).toBeUndefined();
  });

  test("dashboard summary for online reservations", async () => {
    const res = await desk.get("/online-reservations/summary");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ arrivalsToday: 0 });
    expect(res.data.upcoming).toBeGreaterThan(0);
    expect(res.data.problemsLast7Days).toBeGreaterThanOrEqual(4);
    expect(res.data.receivedToday).toBeGreaterThan(0);
  });
});
