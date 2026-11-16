/**
 * Member 1 (Guest Booking System) and Member 4 (Restaurant POS) against the
 * PMS, with both systems simulated: IntegrationClient for their calls into the
 * PMS and local webhook receivers for the PMS's notifications to them.
 */
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, newKey, startReceiver } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { Room, Reservation, StayCharge } from "../models/index.js";
import { today, addDays } from "../utils/dates.js";

let app;
let desk;
let booking;
let pos;
let bookingHooks;
let posHooks;
const D0 = today();
const D = (n) => addDays(D0, n);
const ctx = {};

const roomStatus = async (n) => (await Room.findOne({ where: { roomNumber: n } })).status;

const reservationBody = (id, extra = {}) => ({
  external_reservation_id: id,
  guest: { first_name: "John", last_name: "Doe", email: "john@example.com", phone: "09123456789" },
  room_type_id: ctx.types.Deluxe,
  check_in_date: D0,
  check_out_date: D(2),
  number_of_guests: 2,
  ...extra,
});

async function verifyAndCheckIn(reservationId, name) {
  const v = await desk.post("/verifications", { reservationId, idType: "PASSPORT", idNumberLast4: "4321", nameOnId: name, expiryDate: D(3650), photoMatches: true });
  expect(v.data.result).toBe("VERIFIED");
  const res = await desk.post("/check-ins", { reservationId });
  expect(res.status).toBe(201);
  return res.data;
}

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  booking = new IntegrationClient(app.base, "booking", process.env.BOOKING_API_KEY);
  pos = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY);
  bookingHooks = await startReceiver("BOOKING", process.env.BOOKING_WEBHOOK_SECRET);
  posHooks = await startReceiver("POS", process.env.POS_WEBHOOK_SECRET);
});
afterAll(async () => {
  await bookingHooks?.close();
  await posHooks?.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Member 1 — Guest Booking System", () => {
  test("room types are published with stable ids", async () => {
    const res = await booking.get("/room-types");
    expect(res.status).toBe(200);
    ctx.types = Object.fromEntries(res.data.map((t) => [t.room_type, t.room_type_id]));
    expect(Object.keys(ctx.types)).toEqual(expect.arrayContaining(["Standard", "Deluxe", "Family"]));
    expect(res.data.find((t) => t.room_type === "Standard")).toMatchObject({ room_count: 2, max_capacity: 2, min_nightly_rate: 2500 });
  });

  test("availability per room type", async () => {
    const res = await booking.get(`/availability?check_in_date=${D0}&check_out_date=${D(2)}&room_type_id=${ctx.types.Deluxe}`);
    expect(res.status).toBe(200);
    expect(res.data.room_types).toEqual([expect.objectContaining({ room_type_id: ctx.types.Deluxe, room_type: "Deluxe", available_rooms: 1 })]);
  });

  test("a successful reservation: guest created, room assigned and RESERVED, ids returned", async () => {
    const res = await booking.post("/reservations", reservationBody("BOOK-10001"));
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      external_reservation_id: "BOOK-10001",
      status: "CONFIRMED",
      room_type_id: ctx.types.Deluxe,
      room_type: "Deluxe",
      room_assignment: "ASSIGNED",
      room: { room_number: "204", status: "RESERVED" },
      check_in_date: D0,
      check_out_date: D(2),
      number_of_guests: 2,
    });
    expect(res.data.reservation_id).toEqual(expect.any(Number));
    expect(res.data.reservation_code).toMatch(/^RSV-\d+$/);
    expect(await roomStatus("204")).toBe("RESERVED");
    ctx.deluxe = res.data;
    // The front desk sees it as a normal reservation from the booking system.
    const staffView = await desk.get(`/reservations/${res.data.reservation_id}`);
    expect(staffView.data).toMatchObject({ source: "RESERVATION_SYSTEM", externalReservationId: "BOOK-10001", guest: { email: "john@example.com" } });
  });

  test("an existing guest is matched instead of duplicated", async () => {
    const res = await booking.post("/reservations", reservationBody("BOOK-10002", { room_type_id: ctx.types.Family, check_in_date: D(40), check_out_date: D(41) }));
    expect(res.status).toBe(201);
    expect(res.data.guest_id).toBe(ctx.deluxe.guest_id);
  });

  test("invalid payloads → 422 with field details", async () => {
    const res = await booking.post("/reservations", { external_reservation_id: "bad id!", guest: {}, check_in_date: "tomorrow", number_of_guests: 0 });
    expect(res.status).toBe(422);
    expect(Object.keys(res.error.details)).toEqual(expect.arrayContaining(["external_reservation_id", "guest", "check_in_date", "check_out_date", "number_of_guests"]));

    const unknownType = await booking.post("/reservations", reservationBody("BOOK-BAD1", { room_type_id: 999 }));
    expect(unknownType.status).toBe(422);
    expect(unknownType.error.details.room_type_id).toBeDefined();

    const backwards = await booking.post("/reservations", reservationBody("BOOK-BAD2", { check_in_date: D(5), check_out_date: D(4) }));
    expect(backwards.status).toBe(422);

    const past = await booking.post("/reservations", reservationBody("BOOK-BAD3", { check_in_date: D(-1) }));
    expect(past.status).toBe(422);

    const tooMany = await booking.post("/reservations", reservationBody("BOOK-BAD4", { number_of_guests: 3 }));
    expect(tooMany.status).toBe(422);
    expect(tooMany.error.details.numGuests).toBeDefined();
  });

  test("no room available → 409 NO_AVAILABILITY, nothing stored", async () => {
    const res = await booking.post("/reservations", reservationBody("BOOK-10003"));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("NO_AVAILABILITY");
    expect(await Reservation.count({ where: { externalReservationId: "BOOK-10003" } })).toBe(0);
  });

  test("the same external reservation under a new Idempotency-Key → 409 DUPLICATE_RESERVATION", async () => {
    const res = await booking.post("/reservations", reservationBody("BOOK-10001"));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("DUPLICATE_RESERVATION");
    expect(res.error.details.reservation_id).toBe(ctx.deluxe.reservation_id);
  });

  test("concurrent bookings for the last rooms: never double-booked", async () => {
    const make = (id) => booking.post("/reservations", reservationBody(id, { room_type_id: ctx.types.Standard, check_in_date: D(10), check_out_date: D(12), number_of_guests: 1 }));
    const results = await Promise.all(["BOOK-C1", "BOOK-C2", "BOOK-C3"].map(make));
    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(2);
    expect(results.filter((r) => r.status === 409).map((r) => r.error.code)).toEqual(["NO_AVAILABILITY"]);
    expect(new Set(ok.map((r) => r.data.room.room_number))).toEqual(new Set(["101", "102"]));
    ctx.standard = ok;
  });

  test("concurrent duplicates of one booking: exactly one is stored", async () => {
    const body = reservationBody("BOOK-DUP", { room_type_id: ctx.types.Family, check_in_date: D(50), check_out_date: D(51) });
    const results = await Promise.all([booking.post("/reservations", body), booking.post("/reservations", body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Reservation.count({ where: { externalReservationId: "BOOK-DUP" } })).toBe(1);
  });

  test("GET returns the reservation by the booking system's id; unknown id → 404", async () => {
    const res = await booking.get("/reservations/BOOK-10001");
    expect(res.data).toMatchObject({ reservation_id: ctx.deluxe.reservation_id, status: "CONFIRMED", room: { room_number: "204" } });
    expect((await booking.get("/reservations/NOPE-1")).status).toBe(404);
  });

  test("an update keeps the room when it is still free for the new dates", async () => {
    const [first] = ctx.standard;
    const res = await booking.patch(`/reservations/${first.data.external_reservation_id}`, { check_in_date: D(20), check_out_date: D(22), payment_status: "PREPAID" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ check_in_date: D(20), check_out_date: D(22), payment_status: "PREPAID", room: { room_number: first.data.room.room_number } });
  });

  test("cancellation releases the room (RESERVED → AVAILABLE) and is not echoed back", async () => {
    const [, second] = ctx.standard;
    const roomNumber = second.data.room.room_number;
    expect(await roomStatus(roomNumber)).toBe("RESERVED");
    const res = await booking.post(`/reservations/${second.data.external_reservation_id}/cancel`, { reason: "Guest cancelled online" });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("CANCELLED");
    expect(await roomStatus(roomNumber)).toBe("AVAILABLE");

    const again = await booking.post(`/reservations/${second.data.external_reservation_id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("RESERVATION_NOT_MODIFIABLE");

    await processOutbox();
    expect(bookingHooks.events("ReservationCancelled")).toHaveLength(0);
  });

  test("a front-desk room change is pushed to the booking system as a signed ReservationUpdated webhook", async () => {
    const [first] = ctx.standard;
    const from = first.data.room.room_number;
    const to = from === "101" ? "102" : "101";
    const target = await Room.findOne({ where: { roomNumber: to } });
    const res = await desk.put(`/reservations/${first.data.reservation_id}/room`, { roomId: target.id });
    expect(res.status).toBe(200);
    expect(await roomStatus(from)).toBe("AVAILABLE");
    expect(await roomStatus(to)).toBe("RESERVED");

    await processOutbox();
    const hook = bookingHooks.received.find((r) => r.body.event === "ReservationUpdated" && r.body.external_reservation_id === first.data.external_reservation_id);
    expect(hook).toBeDefined();
    expect(hook.signatureValid).toBe(true);
    expect(hook.headers["x-pms-event-id"]).toBe(hook.body.event_id);
    expect(hook.body).toMatchObject({ event_id: expect.stringMatching(/^EVT-\d{6}$/), origin: "PMS", source: "BOOKING", room_number: to, status: "CONFIRMED" });
    expect(hook.body.guest).toBeUndefined(); // no guest contact data in webhooks
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Member 4 — Restaurant POS: charge to room", () => {
  const charge = (id, extra = {}) => ({
    external_transaction_id: id,
    room_number: "204",
    guest_name: "John Doe",
    reservation_id: ctx.deluxe.reservation_id,
    amount: 850.0,
    currency: "PHP",
    description: "Restaurant Order",
    items: [
      { name: "Chicken Adobo", quantity: 2, unit_price: 250.0 },
      { name: "Iced Tea", quantity: 2, unit_price: 175.0 },
    ],
    transaction_date: new Date().toISOString(),
    ...extra,
  });

  test("charges are refused before the guest has checked in", async () => {
    const res = await pos.post("/room-charges", charge("POS-EARLY"));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("RESERVATION_NOT_ACTIVE");
  });

  test("check-in notifies the POS and the booking system (GuestCheckedIn)", async () => {
    ctx.stay = await verifyAndCheckIn(ctx.deluxe.reservation_id, "John Doe");
    expect(await roomStatus("204")).toBe("OCCUPIED");
    await processOutbox();
    const [toPos] = posHooks.events("GuestCheckedIn");
    expect(toPos).toMatchObject({ reservation_id: ctx.deluxe.reservation_id, room_number: "204", stay_id: ctx.stay.id, guest_display_name: "J. Doe", status: "CHECKED_IN" });
    expect(posHooks.received[0].signatureValid).toBe(true);
    const [toBooking] = bookingHooks.events("GuestCheckedIn");
    expect(toBooking).toMatchObject({ external_reservation_id: "BOOK-10001", status: "CHECKED_IN" });
    expect(toBooking.event_id).toBe(toPos.event_id); // one event, two receivers
  });

  test("in-house lookup returns the reservation id and a masked name only", async () => {
    const res = await pos.get("/in-house?room_number=204");
    expect(res.data).toMatchObject({ reservation_id: ctx.deluxe.reservation_id, stay_id: ctx.stay.id, guest_display_name: "J. Doe", folio_open: true });
    expect((await pos.get("/in-house?room_number=101")).status).toBe(404);
  });

  test("a valid restaurant charge is posted to the guest folio", async () => {
    const res = await pos.post("/room-charges", charge("POS-10001"));
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ status: "POSTED", external_transaction_id: "POS-10001", reservation_id: ctx.deluxe.reservation_id, stay_id: ctx.stay.id, amount: 850, currency: "PHP" });
    const folio = (await desk.get(`/stays/${ctx.stay.id}/folio`)).data;
    expect(folio.totals.restaurantCharges).toBe(850);
    expect(folio.lines.find((l) => l.reference === "POS-10001")).toMatchObject({ type: "RESTAURANT", amount: 850 });
    expect((await pos.get("/room-charges/POS-10001")).data.charge_id).toBe(res.data.charge_id);
  });

  test("duplicate POS transactions are never posted twice", async () => {
    const key = newKey("pos");
    const body = charge("POS-10002", { amount: 175, items: [{ name: "Iced Tea", quantity: 1, unit_price: 175 }] });
    const first = await pos.post("/room-charges", body, { key });
    expect(first.status).toBe(201);
    // Network retry: same key, same body → the stored response, no new charge.
    const replay = await pos.post("/room-charges", body, { key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    // Same transaction re-sent under a new key → 409.
    const dup = await pos.post("/room-charges", body);
    expect(dup.status).toBe(409);
    expect(dup.error.code).toBe("DUPLICATE_TRANSACTION");
    expect(dup.error.details.charge_id).toBe(first.data.charge_id);
    expect(await StayCharge.count({ where: { externalTransactionId: "POS-10002" } })).toBe(1);
  });

  test.each([
    ["room not belonging to the reservation", { room_number: "101" }, 409, "ROOM_MISMATCH"],
    ["guest name not matching", { guest_name: "Jane Smith" }, 409, "GUEST_MISMATCH"],
    ["unknown reservation", { reservation_id: 999999 }, 404, "RESERVATION_NOT_FOUND"],
    ["foreign currency", { currency: "USD" }, 422, "VALIDATION_ERROR"],
    ["items not adding up to the amount", { amount: 900 }, 422, "VALIDATION_ERROR"],
    ["zero amount", { amount: 0, items: [] }, 422, "VALIDATION_ERROR"],
    ["transaction in the future", { transaction_date: new Date(Date.now() + 3_600_000).toISOString() }, 422, "VALIDATION_ERROR"],
  ])("invalid charge: %s → %i %s", async (_, change, status, code) => {
    const res = await pos.post("/room-charges", charge(`POS-BAD-${Math.random().toString(36).slice(2, 8)}`, change));
    expect(res.status).toBe(status);
    expect(res.error.code).toBe(code);
  });

  test("a confirmed reservation that is not checked in cannot be charged", async () => {
    const [first] = ctx.standard;
    const res = await pos.post("/room-charges", charge("POS-NOTIN", { reservation_id: first.data.reservation_id, room_number: (await desk.get(`/reservations/${first.data.reservation_id}`)).data.room.roomNumber }));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("RESERVATION_NOT_ACTIVE");
  });

  test("charges reach the final bill; once the bill is confirmed the folio is closed", async () => {
    const billed = await desk.post("/bills", { stayId: ctx.stay.id });
    expect(billed.data.bill.totals).toMatchObject({ roomCharge: 3500, chargesTotal: 1025, totalDue: 4525 });
    await desk.post(`/bills/${billed.data.bill.id}/confirm`);
    const res = await pos.post("/room-charges", charge("POS-LATE"));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("FOLIO_CLOSED");
    ctx.billId = billed.data.bill.id;
  });

  test("after checkout the reservation can no longer be charged; POS is told the guest left", async () => {
    expect((await desk.post("/payments", { billId: ctx.billId, method: "CASH", amount: 4525 })).data.status).toBe("SUCCESSFUL");
    expect((await desk.post("/checkouts", { stayId: ctx.stay.id })).status).toBe(201);
    const res = await pos.post("/room-charges", charge("POS-AFTER"));
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("RESERVATION_NOT_ACTIVE");
    await processOutbox();
    expect(posHooks.events("GuestCheckedOut")[0]).toMatchObject({ reservation_id: ctx.deluxe.reservation_id, folio: { restaurant_charges: 1025, balance: 0 } });
    expect(bookingHooks.events("GuestCheckedOut")[0]).toMatchObject({ external_reservation_id: "BOOK-10001", status: "CHECKED_OUT" });
  });
});
