/**
 * Restaurant POS purchase notifications → front-desk review → guest folio.
 *
 * The external Restaurant POS is simulated (IntegrationClient with the POS
 * key, local webhook receiver). Covers: valid / invalid orders, API key,
 * scope and HMAC signature failures (incl. replay), duplicate deliveries,
 * concurrent deliveries, guest matching (never by room / name alone), room
 * mismatches, notifications and who may see / decide, approve, reject,
 * folio + checkout arithmetic, already-paid orders, voids, concurrent
 * approvals, and both directions of the legacy /room-charges duplicate guard.
 */
import { Op } from "sequelize";
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, newKey, startReceiver } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { config } from "../config/index.js";
import { Room, User, PosOrder, StayCharge, Payment } from "../models/index.js";
import { today, addDays } from "../utils/dates.js";

let app;
let desk;
let admin;
let pos;
let posHooks;
const D0 = today();
const D = (n) => addDays(D0, n);
const ctx = {};
let seq = 0;
const oid = (p = "ORD") => `${p}-${Date.now().toString(36)}-${++seq}`;

async function reserve(firstName, lastName, roomNumber) {
  const room = await Room.findOne({ where: { roomNumber } });
  const res = await desk.post("/reservations", { guest: { firstName, lastName }, roomId: room.id, checkInDate: D0, checkOutDate: D(2), numGuests: 1 });
  expect(res.status).toBe(201);
  return res.data;
}
async function checkIn(reservation) {
  const name = `${reservation.guest.firstName} ${reservation.guest.lastName}`;
  const v = await desk.post("/verifications", { reservationId: reservation.id, idType: "PASSPORT", idNumberLast4: "4321", nameOnId: name, expiryDate: D(3650), photoMatches: true });
  expect(v.data.result).toBe("VERIFIED");
  const res = await desk.post("/check-ins", { reservationId: reservation.id });
  expect(res.status).toBe(201);
  return { reservation, stay: res.data, code: reservation.reservationCode };
}

/** A purchase for John Doe (room 204) unless overridden. */
const order = (id, extra = {}) => ({
  external_order_id: id,
  restaurant_id: "R1",
  outlet_name: "Lobby Restaurant",
  customer_name: "John Doe",
  reservation_code: ctx.john.code,
  room_number: "204",
  items: [
    { sku: "F-12", name: "Club sandwich", description: "No onions", category: "FOOD", quantity: 2, unit_price: 350 },
    { name: "Iced tea", category: "BEVERAGE", quantity: 1, unit_price: 100 },
  ],
  subtotal: 800,
  service_charge: 80,
  tax: 0,
  discount: 0,
  total: 880,
  currency: "PHP",
  // One fixed time (after check-in), so re-sending order(id) is byte-for-byte the same order.
  ordered_at: ctx.orderedAt,
  payment_status: "CHARGE_TO_ROOM",
  order_status: "COMPLETED",
  ...extra,
});

const send = (body, opts) => pos.post("/orders", body, opts);
const row = (id, restaurantId = "R1") => PosOrder.findOne({ where: { restaurantId, externalOrderId: id } });
const folio = async (stayId) => (await desk.get(`/stays/${stayId}/folio`)).data;
const staffId = async (username) => (await User.findOne({ where: { username } })).id;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
  pos = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY);
  posHooks = await startReceiver("POS", process.env.POS_WEBHOOK_SECRET);

  ctx.john = await checkIn(await reserve("John", "Doe", "204"));
  ctx.maria = await checkIn(await reserve("Maria", "Santos", "101"));
  ctx.ana = await checkIn(await reserve("Ana", "Reyes", "301"));
  ctx.pedro = await reserve("Pedro", "Cruz", "102"); // confirmed, not checked in
  ctx.orderedAt = new Date().toISOString();
});
afterAll(async () => {
  await posHooks?.close();
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Receiving POS purchases", () => {
  test("a valid order with a certain match is queued for review — nothing is billed or paid", async () => {
    const id = oid();
    const res = await send(order(id));
    expect(res.status).toBe(202);
    expect(res.data).toMatchObject({
      restaurant_id: "R1",
      external_order_id: id,
      status: "PENDING_REVIEW",
      reservation_id: ctx.john.reservation.id,
      reservation_code: ctx.john.code,
      room_number: "204",
      guest_display_name: "J. Doe",
      total: 880,
      currency: "PHP",
      duplicate: false,
      verification_reasons: [],
    });
    expect(res.data.order_ref).toMatch(/^PO-\d{6}$/);
    // Privacy: the POS never gets the guest's full name back.
    expect(JSON.stringify(res.body)).not.toMatch(/John/);

    const stored = await row(id);
    expect(stored).toMatchObject({ status: "PENDING_REVIEW", matchedStayId: ctx.john.stay.id, matchedReservationId: ctx.john.reservation.id, deliveryCount: 1, stayChargeId: null });
    expect(await StayCharge.count()).toBe(0);
    expect(await Payment.count()).toBe(0);
    expect((await folio(ctx.john.stay.id)).totals.restaurantCharges).toBe(0);
    ctx.firstOrder = id;
  });

  test("the reservation id identifies the stay just as well as the code", async () => {
    const res = await send(order(oid(), { reservation_code: undefined, reservation_id: ctx.john.reservation.id }));
    expect(res.status).toBe(202);
    expect(res.data.status).toBe("PENDING_REVIEW");
  });

  test.each([
    ["missing order id", { external_order_id: undefined }, "external_order_id"],
    ["bad order id characters", { external_order_id: "ORD 1/2" }, "external_order_id"],
    ["no items", { items: [], subtotal: 0, service_charge: 0, total: 0.01 }, "items"],
    ["subtotal not the sum of items", { subtotal: 900, total: 980 }, "subtotal"],
    ["total not subtotal + service − discount", { total: 999 }, "total"],
    ["foreign currency", { currency: "USD" }, "currency"],
    ["order time in the future", { ordered_at: new Date(Date.now() + 3_600_000).toISOString() }, "ordered_at"],
    ["unknown payment status", { payment_status: "MAYBE" }, "payment_status"],
    ["unknown order status", { order_status: "OPEN" }, "order_status"],
    ["zero quantity", { items: [{ name: "Water", quantity: 0, unit_price: 50 }], subtotal: 0, service_charge: 0, total: 0.01 }, "items"],
    ["amount with 3 decimals", { total: 880.001 }, "total"],
    ["reservation code with a bad format", { reservation_code: "7" }, "reservation_code"],
  ])("invalid order: %s → 422", async (_, change, field) => {
    const res = await send(order(oid("BAD"), change));
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("VALIDATION_ERROR");
    expect(res.error.details).toHaveProperty(field);
  });

  test("a restaurant that is not connected to this hotel is refused", async () => {
    const saved = config.integrations.posOrders.restaurantIds;
    config.integrations.posOrders.restaurantIds = ["R1", "R2"];
    try {
      const res = await send(order(oid(), { restaurant_id: "R9" }));
      expect(res.status).toBe(422);
      expect(res.error.details.restaurant_id).toBeDefined();
      expect((await send(order(oid(), { restaurant_id: "R2" }))).status).toBe(202);
    } finally {
      config.integrations.posOrders.restaurantIds = saved;
    }
  });

  test("without restaurant_id the configured default restaurant is used", async () => {
    const id = oid();
    const res = await send(order(id, { restaurant_id: undefined }));
    expect(res.status).toBe(202);
    expect(res.data.restaurant_id).toBe(config.integrations.posOrders.defaultRestaurantId);
  });

  test("a void for an order never received is refused", async () => {
    const res = await send(order(oid(), { order_status: "VOIDED" }));
    expect(res.status).toBe(422);
    expect(res.error.details.order_status).toBeDefined();
  });

  test("nothing invalid was stored", async () => {
    expect(await PosOrder.count({ where: { externalOrderId: { [Op.like]: "BAD-%" } } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Authentication and request security", () => {
  test("missing or wrong API key → 401, nothing stored", async () => {
    const id = oid();
    expect((await send(order(id), { apiKey: "" })).status).toBe(401);
    const wrong = await send(order(id), { apiKey: "not-the-pos-key-123456" });
    expect(wrong.status).toBe(401);
    expect(wrong.error.code).toBe("INVALID_API_KEY");
    expect(await row(id)).toBeNull();
  });

  test("another system's key cannot send POS orders (403 INSUFFICIENT_SCOPE)", async () => {
    const hr = new IntegrationClient(app.base, "pos", process.env.HR_API_KEY);
    const res = await hr.post("/orders", order(oid()));
    expect(res.status).toBe(403);
    expect(res.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  test("the Idempotency-Key header is required", async () => {
    const res = await send(order(oid()), { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("with POS_INBOUND_SECRET every order must be signed; expired timestamps (replays) and tampering are refused", async () => {
    const secret = "test-pos-inbound-secret";
    const settings = config.integrations.clients.POS;
    settings.inboundSecret = secret;
    try {
      const signed = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY, { signingSecret: secret });
      const unsigned = await send(order(oid()));
      expect(unsigned.status).toBe(401);
      expect(unsigned.error.code).toBe("SIGNATURE_REQUIRED");

      const wrongSecret = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY, { signingSecret: "wrong" });
      expect((await wrongSecret.post("/orders", order(oid()))).error.code).toBe("INVALID_SIGNATURE");

      const old = String(Math.floor(Date.now() / 1000) - 3600);
      const replay = await signed.post("/orders", order(oid()), { timestamp: old });
      expect(replay.status).toBe(401);
      expect(replay.error.code).toBe("SIGNATURE_EXPIRED");

      const ok = await signed.post("/orders", order(oid()));
      expect(ok.status).toBe(202);
    } finally {
      settings.inboundSecret = "";
    }
  });

  test("a POS key cannot reach the staff review API", async () => {
    const res = await fetch(`${app.base}/api/v1/pos-orders`, { headers: { "X-Api-Key": process.env.POS_API_KEY, Accept: "application/json" } });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Duplicate deliveries", () => {
  test("a retried webhook never creates a second order, notification or charge", async () => {
    const id = oid();
    const key = newKey("pos");
    const body = order(id);
    const first = await send(body, { key });
    expect(first.status).toBe(202);
    const summaryBefore = (await desk.get("/pos-orders/summary")).data;

    // Network retry with the same Idempotency-Key: stored response replayed.
    const replay = await send(body, { key });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    // Re-delivery under a new key: recognised by (restaurant_id, external_order_id).
    const again = await send(body);
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ order_ref: first.data.order_ref, status: "PENDING_REVIEW", duplicate: true });

    expect(await PosOrder.count({ where: { externalOrderId: id } })).toBe(1);
    expect((await row(id)).deliveryCount).toBe(2);
    expect((await desk.get("/pos-orders/summary")).data.open).toBe(summaryBefore.open);
  });

  test("the same order id re-sent with different content is refused and recorded", async () => {
    const id = oid();
    await send(order(id));
    const changed = await send(order(id, { items: [{ name: "Club sandwich", quantity: 3, unit_price: 350 }], subtotal: 1050, service_charge: 0, total: 1050 }));
    expect(changed.status).toBe(409);
    expect(changed.error.code).toBe("ORDER_CONFLICT");
    const stored = await row(id);
    expect(Number(stored.total)).toBe(880);
    expect(stored.processingError).toMatch(/different content/);
  });

  test("the same order id from another restaurant is a different order", async () => {
    const id = oid();
    expect((await send(order(id, { restaurant_id: "R1" }))).status).toBe(202);
    expect((await send(order(id, { restaurant_id: "R2" }))).status).toBe(202);
    expect(await PosOrder.count({ where: { externalOrderId: id } })).toBe(2);
  });

  test("concurrent deliveries of one order: exactly one is stored", async () => {
    const id = oid();
    const results = await Promise.all(Array.from({ length: 6 }, () => send(order(id))));
    expect(results.every((r) => r.status === 202 || r.status === 200)).toBe(true);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(new Set(results.map((r) => r.data.order_ref)).size).toBe(1);
    expect(await PosOrder.count({ where: { externalOrderId: id } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Guest and reservation matching", () => {
  const expectVerification = async (body, reasons) => {
    const res = await send(body);
    expect(res.status).toBe(202);
    expect(res.data.status).toBe("NEEDS_GUEST_VERIFICATION");
    expect(res.data.verification_reasons).toEqual(expect.arrayContaining(reasons));
    // No stay is suggested and no guest data is disclosed for an uncertain match.
    expect(res.data).toMatchObject({ reservation_id: null, reservation_code: null, room_number: null, guest_display_name: null });
    const stored = await row(body.external_order_id, body.restaurant_id);
    expect(stored.matchedStayId).toBeNull();
    return stored;
  };

  test("room number not matching the reservation → needs verification", async () => {
    const stored = await expectVerification(order(oid(), { room_number: "101" }), ["ROOM_MISMATCH"]);
    expect(stored.matchedReservationId).toBe(ctx.john.reservation.id); // kept for the staff screens and the billing guard
    ctx.roomMismatch = stored.id;
  });

  test("customer name not matching the registered guest → needs verification", async () => {
    await expectVerification(order(oid(), { customer_name: "Jane Smith" }), ["NAME_MISMATCH"]);
  });

  test("room number and name alone are never trusted", async () => {
    const stored = await expectVerification(order(oid(), { reservation_code: undefined }), ["NO_RESERVATION_REFERENCE"]);
    expect(stored.matchedReservationId).toBeNull();
    ctx.noReference = stored.id;
  });

  test.each([
    ["unknown reservation", () => ({ reservation_code: "RSV-99999" }), "RESERVATION_NOT_FOUND"],
    ["reservation not checked in", () => ({ reservation_code: ctx.pedro.reservationCode, room_number: "102", customer_name: "Pedro Cruz" }), "NOT_IN_HOUSE"],
    ["guest id of someone else", () => ({ guest_id: ctx.maria.reservation.guest.id }), "GUEST_ID_MISMATCH"],
    ["id and code of different reservations", () => ({ reservation_id: ctx.maria.reservation.id }), "RESERVATION_REFERENCE_MISMATCH"],
    ["ordered before the guest checked in", () => ({ ordered_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }), "ORDERED_BEFORE_CHECK_IN"],
  ])("%s → needs verification (%s)", async (_, change, reason) => {
    await expectVerification(order(oid(), change()), [reason]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Notifications and who may act", () => {
  test("the badge summary gives counts only — no guest or order details", async () => {
    const res = await desk.get("/pos-orders/summary");
    expect(res.status).toBe(200);
    expect(Object.keys(res.data).sort()).toEqual(["attention", "latestOpenId", "needsAdjustment", "needsVerification", "open", "pendingReview"]);
    expect(res.data.pendingReview).toBeGreaterThan(0);
    expect(res.data.needsVerification).toBeGreaterThan(0);
    expect(res.data.open).toBe(res.data.pendingReview + res.data.needsVerification);
    expect(JSON.stringify(res.data)).not.toMatch(/John|Doe/);
  });

  test("signed-out users get nothing", async () => {
    const res = await fetch(`${app.base}/api/v1/pos-orders/summary`, { headers: { Accept: "application/json" } });
    expect(res.status).toBe(401);
  });

  test("staff see the queue with customer, reservation, room, items, total and POS reference", async () => {
    const { data, meta } = (await desk.get("/pos-orders?status=OPEN")).body;
    expect(meta.total).toBeGreaterThan(0);
    const first = data.find((o) => o.externalOrderId === ctx.firstOrder);
    expect(first).toMatchObject({
      status: "PENDING_REVIEW",
      customerName: "John Doe",
      roomNumber: "204",
      total: 880,
      reservation: { reservationCode: ctx.john.code, roomNumber: "204", guestName: "John Doe" },
    });
    expect(first.items[0]).toMatchObject({ name: "Club sandwich", quantity: 2, unitPrice: 350, lineTotal: 700 });
  });

  test("the dashboard tells staff that purchases are waiting", async () => {
    const d = (await desk.get("/dashboard")).data;
    expect(d.notifications.some((n) => n.href === "/front-desk/restaurant-charges")).toBe(true);
  });

  test("an uncertain purchase lists candidate in-house stays for the receptionist", async () => {
    const detail = (await desk.get(`/pos-orders/${ctx.roomMismatch}`)).data;
    const john = detail.candidates.find((c) => c.stayId === ctx.john.stay.id);
    const maria = detail.candidates.find((c) => c.stayId === ctx.maria.stay.id);
    expect(john.reasons).toEqual(expect.arrayContaining(["RESERVATION", "NAME"]));
    expect(maria.reasons).toContain("ROOM"); // room 101 was sent
    expect(detail.candidates.every((c) => !c.suggested)).toBe(true);
  });

  test("administrators can view but not approve, reject or resolve", async () => {
    expect((await admin.get("/pos-orders?status=OPEN")).status).toBe(200);
    const o = await row(ctx.firstOrder);
    expect((await admin.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id })).status).toBe(403);
    expect((await admin.post(`/pos-orders/${o.id}/reject`, { reason: "No" })).status).toBe(403);
    expect((await admin.post(`/pos-orders/${o.id}/resolve-void`)).status).toBe(403);
    expect((await row(ctx.firstOrder)).status).toBe("PENDING_REVIEW");
  });

  test("CSRF protection applies to review actions", async () => {
    const o = await row(ctx.firstOrder);
    const res = await desk.api("POST", `/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id }, { csrf: false });
    expect(res.status).toBe(403);
    expect((await row(ctx.firstOrder)).status).toBe("PENDING_REVIEW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Approving, rejecting and the guest folio", () => {
  test("approving adds an outstanding charge to the folio, linked to the order, guest, reservation and approver", async () => {
    posHooks.clear();
    const o = await row(ctx.firstOrder);
    const res = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "ADDED_TO_FOLIO", stayId: ctx.john.stay.id, reviewedBy: { id: await staffId("frontdesk") } });
    expect(res.data.reviewedAt).toBeTruthy();

    const charge = await StayCharge.findByPk(res.data.chargeId);
    expect(charge).toMatchObject({ stayId: ctx.john.stay.id, sourceSystem: "POS", externalTransactionId: `R1:${ctx.firstOrder}`, category: "FOOD", outlet: "Lobby Restaurant" });
    expect(Number(charge.amount)).toBe(880);
    expect(charge.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)).toBe(880); // service charge line included

    const f = await folio(ctx.john.stay.id);
    expect(f.totals).toMatchObject({ restaurantCharges: 880, payments: 0 });
    expect(f.lines.find((l) => l.reference === `R1:${ctx.firstOrder}`)).toMatchObject({ type: "RESTAURANT", amount: 880 });
    expect(await Payment.count()).toBe(0); // billing, not payment

    await processOutbox();
    const [hook] = posHooks.events("PosOrderReviewed");
    expect(hook).toMatchObject({ external_order_id: ctx.firstOrder, restaurant_id: "R1", status: "ADDED_TO_FOLIO", stay_id: ctx.john.stay.id, charge_id: charge.id, amount: 880 });
    expect(JSON.stringify(hook)).not.toMatch(/John/);
    expect(posHooks.received.at(-1).signatureValid).toBe(true);

    const status = await pos.get(`/orders/R1/${ctx.firstOrder}`);
    expect(status.data).toMatchObject({ status: "ADDED_TO_FOLIO", charge_id: charge.id, reservation_code: ctx.john.code });
  });

  test("an order can only be approved once", async () => {
    const o = await row(ctx.firstOrder);
    const again = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe("ORDER_ALREADY_REVIEWED");
    expect(await StayCharge.count({ where: { externalTransactionId: `R1:${ctx.firstOrder}` } })).toBe(1);
  });

  test("an uncertain purchase needs a verification note, then can be added to the stay staff verified", async () => {
    const noNote = await desk.post(`/pos-orders/${ctx.noReference}/approve`, { stayId: ctx.john.stay.id });
    expect(noNote.status).toBe(422);
    expect(noNote.error.details.note).toBeDefined();
    const ok = await desk.post(`/pos-orders/${ctx.noReference}/approve`, { stayId: ctx.john.stay.id, note: "Guest confirmed at the desk; signed chit" });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ status: "ADDED_TO_FOLIO", reviewNote: "Guest confirmed at the desk; signed chit", reservation: { id: ctx.john.reservation.id } });
  });

  test("choosing a different stay than the suggested one also needs a note", async () => {
    const id = oid();
    await send(order(id));
    const o = await row(id);
    const res = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.maria.stay.id });
    expect(res.status).toBe(422);
    expect(res.error.details.note).toBeDefined();
    ctx.toReject = o.id;
  });

  test("rejecting needs a reason; the order is never billed and the POS can see why", async () => {
    expect((await desk.post(`/pos-orders/${ctx.toReject}/reject`, {})).status).toBe(422);
    const before = (await folio(ctx.john.stay.id)).totals.restaurantCharges;
    const res = await desk.post(`/pos-orders/${ctx.toReject}/reject`, { reason: "Guest says this is not their order" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "REJECTED", rejectionReason: "Guest says this is not their order", chargeId: null });
    expect((await folio(ctx.john.stay.id)).totals.restaurantCharges).toBe(before);
    const o = await PosOrder.findByPk(ctx.toReject);
    const status = await pos.get(`/orders/R1/${o.externalOrderId}`);
    expect(status.data).toMatchObject({ status: "REJECTED", rejection_reason: "Guest says this is not their order", charge_id: null });
    expect((await desk.post(`/pos-orders/${ctx.toReject}/approve`, { stayId: ctx.john.stay.id, note: "changed my mind" })).status).toBe(409);
  });

  test("two receptionists approving at the same time: exactly one charge", async () => {
    const id = oid();
    await send(order(id));
    const o = await row(id);
    const second = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
    const results = await Promise.all([
      desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id }),
      second.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id }),
      desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await StayCharge.count({ where: { externalTransactionId: `R1:${id}` } })).toBe(1);
  });

  test("orders the restaurant already collected are recorded as ALREADY_PAID and never billed", async () => {
    const id = oid();
    const res = await send(order(id, { payment_status: "PAID" }));
    expect(res.status).toBe(202);
    expect(res.data.status).toBe("ALREADY_PAID");
    const o = await row(id);
    const approve = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id, note: "try" });
    expect(approve.status).toBe(409);
    expect(await StayCharge.count({ where: { externalTransactionId: `R1:${id}` } })).toBe(0);
    expect((await desk.get("/pos-orders/summary")).data.open).toBe(
      await PosOrder.count({ where: { status: ["PENDING_REVIEW", "NEEDS_GUEST_VERIFICATION"] } })
    );
  });

  test("a void before review rejects the order; a void after billing flags it for a bill correction (folio untouched)", async () => {
    const pendingId = oid();
    await send(order(pendingId));
    const voided = await send(order(pendingId, { order_status: "VOIDED" }));
    expect(voided.status).toBe(200);
    expect(voided.data).toMatchObject({ status: "REJECTED", order_status: "VOIDED" });
    expect(voided.data.voided_at).toBeTruthy();
    // A late copy of the original (COMPLETED) does not bring it back.
    expect((await send(order(pendingId))).data.status).toBe("REJECTED");

    const billedId = oid();
    await send(order(billedId));
    const o = await row(billedId);
    await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.john.stay.id });
    const before = (await folio(ctx.john.stay.id)).totals.restaurantCharges;
    const afterVoid = await send(order(billedId, { order_status: "VOIDED" }));
    expect(afterVoid.data.status).toBe("ADDED_TO_FOLIO");
    expect((await folio(ctx.john.stay.id)).totals.restaurantCharges).toBe(before);
    expect((await row(billedId)).needsAdjustment).toBe(true);
    expect((await desk.get("/pos-orders/summary")).data.needsAdjustment).toBe(1);

    const resolved = await desk.post(`/pos-orders/${o.id}/resolve-void`);
    expect(resolved.data).toMatchObject({ needsAdjustment: false, adjustmentResolvedBy: { id: await staffId("frontdesk") } });
    expect((await desk.post(`/pos-orders/${o.id}/resolve-void`)).status).toBe(409);
  });

  test("an order is never billed twice across the legacy /room-charges path and the review queue", async () => {
    // Approved through review first → legacy direct posting with the same order id is refused.
    const reviewedId = oid();
    await send(order(reviewedId));
    await desk.post(`/pos-orders/${(await row(reviewedId)).id}/approve`, { stayId: ctx.john.stay.id });
    const legacy = await pos.post("/room-charges", {
      external_transaction_id: reviewedId,
      reservation_id: ctx.john.reservation.id,
      room_number: "204",
      amount: 880,
      currency: "PHP",
      description: "Restaurant Order",
      transaction_date: new Date().toISOString(),
    });
    expect(legacy.status).toBe(409);
    expect(legacy.error.code).toBe("DUPLICATE_TRANSACTION");
    expect(legacy.headers.get("deprecation")).toBe("true");

    // Posted through the legacy path first → the notification is linked to that charge, not billed again.
    const legacyId = oid("LEG");
    const posted = await pos.post("/room-charges", {
      external_transaction_id: legacyId,
      reservation_id: ctx.john.reservation.id,
      room_number: "204",
      amount: 880,
      currency: "PHP",
      description: "Restaurant Order",
      transaction_date: new Date().toISOString(),
    });
    expect(posted.status).toBe(201);
    const res = await send(order(legacyId));
    expect(res.status).toBe(202);
    expect(res.data).toMatchObject({ status: "ADDED_TO_FOLIO", charge_id: posted.data.charge_id });
    expect(await StayCharge.count({ where: { stayId: ctx.john.stay.id, externalTransactionId: [legacyId, `R1:${legacyId}`] } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Checkout billing", () => {
  test("the bill cannot be confirmed while purchases for the guest await review — including uncertain ones", async () => {
    const res = await send(order(oid(), { customer_name: "Maria Santos", reservation_code: ctx.maria.code, room_number: "101" }));
    expect(res.data.status).toBe("PENDING_REVIEW");
    ctx.mariaOrder = res.data.external_order_id;

    const billed = await desk.post("/bills", { stayId: ctx.maria.stay.id });
    ctx.mariaBill = billed.data.bill.id;
    const confirm = await desk.post(`/bills/${ctx.mariaBill}/confirm`);
    expect(confirm.status).toBe(409);
    expect(confirm.error.code).toBe("POS_ORDERS_PENDING");
    // Maria's clean order, plus the earlier uncertain order that quoted her reservation id.
    const open = (await desk.get(`/pos-orders?status=OPEN&reservationId=${ctx.maria.reservation.id}`)).data;
    expect(open.map((o) => o.status).sort()).toEqual(["NEEDS_GUEST_VERIFICATION", "PENDING_REVIEW"]);
    expect(confirm.error.details.count).toBe(2);

    const uncertain = open.find((o) => o.status === "NEEDS_GUEST_VERIFICATION");
    expect((await desk.post(`/pos-orders/${uncertain.id}/reject`, { reason: "Reservation id and code disagree; restaurant to re-send" })).status).toBe(200);
    const stillBlocked = await desk.post(`/bills/${ctx.mariaBill}/confirm`);
    expect(stillBlocked.error.details.count).toBe(1);
  });

  test("after approval the purchase is on the bill; the guest pays room + restaurant together; the receipt lists it", async () => {
    const o = await row(ctx.mariaOrder);
    expect((await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.maria.stay.id })).status).toBe(200);
    await desk.post("/bills", { stayId: ctx.maria.stay.id }); // recalculate the draft
    const confirm = await desk.post(`/bills/${ctx.mariaBill}/confirm`);
    expect(confirm.status).toBe(200);
    // 1 night × 2500 (room 101) + 880 restaurant
    expect(confirm.data.totals).toMatchObject({ roomCharge: 2500, chargesTotal: 880, adjustmentsTotal: 0, totalDue: 3380 });

    // Paying less than the combined balance is refused: no partial settlement of the room only.
    expect((await desk.post("/payments", { billId: ctx.mariaBill, method: "CASH", amount: 2500 })).error.code).toBe("AMOUNT_MISMATCH");
    const paid = await desk.post("/payments", { billId: ctx.mariaBill, method: "CASH", amount: 3380 });
    expect(paid.data.status).toBe("SUCCESSFUL");
    const receipt = (await desk.get(`/receipts/${paid.data.receipt.id}`)).data;
    expect(receipt.bill.charges).toEqual([expect.objectContaining({ externalTransactionId: `R1:${ctx.mariaOrder}`, amount: 880, category: "FOOD" })]);
    expect(receipt.bill.totals.totalDue).toBe(3380);

    expect((await desk.post("/checkouts", { stayId: ctx.maria.stay.id })).status).toBe(201);
    const f = await folio(ctx.maria.stay.id);
    expect(f.totals).toMatchObject({ roomCharges: 2500, restaurantCharges: 880, totalCharges: 3380, payments: 3380, balance: 0 });
  });

  test("a purchase arriving after checkout cannot be added; the restaurant must collect it", async () => {
    const res = await send(order(oid(), { customer_name: "Maria Santos", reservation_code: ctx.maria.code, room_number: "101" }));
    expect(res.data.status).toBe("NEEDS_GUEST_VERIFICATION");
    expect(res.data.verification_reasons).toContain("NOT_IN_HOUSE");
    const o = await row(res.data.external_order_id);
    const approve = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.maria.stay.id, note: "Late chit" });
    expect(approve.status).toBe(409);
    expect(approve.error.code).toBe("STAY_NOT_IN_HOUSE");
    expect((await desk.post(`/pos-orders/${o.id}/reject`, { reason: "Guest already checked out" })).status).toBe(200);
  });

  test("a purchase arriving after the bill is confirmed is flagged FOLIO_CLOSED and cannot be added", async () => {
    const bill = await desk.post("/bills", { stayId: ctx.ana.stay.id });
    expect((await desk.post(`/bills/${bill.data.bill.id}/confirm`)).status).toBe(200);
    const res = await send(order(oid(), { customer_name: "Ana Reyes", reservation_code: ctx.ana.code, room_number: "301" }));
    expect(res.data.status).toBe("NEEDS_GUEST_VERIFICATION");
    expect(res.data.verification_reasons).toEqual(["FOLIO_CLOSED"]);
    const o = await row(res.data.external_order_id);
    const approve = await desk.post(`/pos-orders/${o.id}/approve`, { stayId: ctx.ana.stay.id, note: "Guest confirmed" });
    expect(approve.status).toBe(409);
    expect(approve.error.code).toBe("FOLIO_CLOSED");
    expect((await row(res.data.external_order_id)).status).toBe("NEEDS_GUEST_VERIFICATION");
  });
});
