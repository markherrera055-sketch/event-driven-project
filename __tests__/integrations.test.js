/**
 * Future-integration readiness: simulated POS and Hotel Reservation System
 * calls (the systems themselves are NOT part of this project).
 * Covers: API-key auth, request validation, idempotency / duplicate
 * protection, overbooking, folio rules and signed outbound webhooks.
 */
import http from "http";
import crypto from "crypto";
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, newKey } from "./helpers/harness.js";
import { processOutbox } from "../integrations/shared/outbox.js";
import { IntegrationOutbox } from "../models/index.js";

let app;
let desk;
let pos;
let rsv;
const ctx = {};
const received = [];
let receiver;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
  pos = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY);
  rsv = new IntegrationClient(app.base, "reservations", process.env.RESERVATION_API_KEY);
  ctx.today = (await desk.get("/me")).data.hotel.today;
  // Local webhook receiver standing in for the future Reservation System.
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise((r) => receiver.listen(39123, "127.0.0.1", r));
});
afterAll(async () => {
  await new Promise((r) => receiver.close(r));
  await app?.close();
});

describe("Integration authentication and validation", () => {
  test("missing API key → 401", async () => {
    const res = await pos.call("GET", "/in-house?roomNumber=101", undefined, { apiKey: "" });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("INVALID_API_KEY");
  });

  test("wrong API key → 401", async () => {
    const res = await rsv.call("GET", "/room-types", undefined, { apiKey: "wrong-key" });
    expect(res.status).toBe(401);
  });

  test("a POS key cannot call the reservation endpoints", async () => {
    const res = await rsv.call("GET", "/room-types", undefined, { apiKey: process.env.POS_API_KEY });
    expect(res.status).toBe(401);
  });

  test("staff session cookies are not accepted in place of an API key", async () => {
    const res = await desk.raw("GET", "/api/v1/integrations/pos/in-house?roomNumber=101");
    expect(res.status).toBe(401);
  });

  test("write without Idempotency-Key → 400", async () => {
    const res = await rsv.call("POST", "/", { externalReservationId: "X" }, { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("invalid payload → 422 with field details", async () => {
    const res = await rsv.call("POST", "/", { externalReservationId: "bad id!", guest: {}, checkInDate: "tomorrow", numGuests: -1 });
    expect(res.status).toBe(422);
    expect(Object.keys(res.error.details)).toEqual(expect.arrayContaining(["externalReservationId", "guest", "roomType", "checkInDate", "numGuests"]));
  });

  test("malformed JSON → 400", async () => {
    const r = await fetch(`${app.base}/api/v1/integrations/reservations/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": process.env.RESERVATION_API_KEY, "Idempotency-Key": newKey() },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });
});

describe("Hotel Reservation System synchronisation (simulated)", () => {
  test("room types and availability are exposed", async () => {
    const types = await rsv.call("GET", "/room-types");
    expect(types.status).toBe(200);
    expect(types.data.map((t) => t.roomType)).toEqual(["Deluxe", "Family", "Standard"]);
    const avail = await rsv.call("GET", `/availability?checkInDate=${ctx.today}&checkOutDate=${addDays(ctx.today, 2)}`);
    expect(avail.status).toBe(200);
    expect(avail.data.roomTypes.find((t) => t.roomType === "Deluxe").availableRooms).toBe(1);
  });

  test("an external booking is stored with its external reference", async () => {
    const res = await rsv.call("POST", "/", {
      externalReservationId: "HRS-1001",
      bookingReference: "BK-7781",
      guest: { firstName: "Maria", lastName: "Santos", email: "maria@example.com" },
      roomType: "Deluxe",
      checkInDate: ctx.today,
      checkOutDate: addDays(ctx.today, 2),
      numGuests: 2,
      paymentStatus: "PREPAID",
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ externalReservationId: "HRS-1001", status: "CONFIRMED", roomType: "Deluxe", paymentStatus: "PREPAID" });
    expect(res.data.pmsReservationCode).toMatch(/^RSV-/);
    ctx.ext = res;
    // Visible to the front desk.
    const list = await desk.get("/reservations?search=HRS-1001");
    expect(list.data[0].source).toBe("RESERVATION_SYSTEM");
  });

  test("retrying with the same Idempotency-Key replays the original response", async () => {
    const body = JSON.parse(JSON.stringify({
      externalReservationId: "HRS-1001",
      bookingReference: "BK-7781",
      guest: { firstName: "Maria", lastName: "Santos", email: "maria@example.com" },
      roomType: "Deluxe",
      checkInDate: ctx.today,
      checkOutDate: addDays(ctx.today, 2),
      numGuests: 2,
      paymentStatus: "PREPAID",
    }));
    const res = await rsv.call("POST", "/", body, { key: ctx.ext.key });
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(res.data.pmsReservationCode).toBe(ctx.ext.data.pmsReservationCode);
  });

  test("same Idempotency-Key with a different body → 422", async () => {
    const res = await rsv.call("POST", "/", { externalReservationId: "HRS-OTHER" }, { key: ctx.ext.key });
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("same externalReservationId with a new key → 409 duplicate (no second reservation)", async () => {
    const res = await rsv.call("POST", "/", {
      externalReservationId: "HRS-1001",
      guest: { firstName: "Maria", lastName: "Santos" },
      roomType: "Deluxe",
      checkInDate: ctx.today,
      checkOutDate: addDays(ctx.today, 2),
      numGuests: 2,
    });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("DUPLICATE_RESERVATION");
    expect(res.error.details.pmsReservationCode).toBe(ctx.ext.data.pmsReservationCode);
  });

  test("overbooking is refused (only one Deluxe room)", async () => {
    const res = await rsv.call("POST", "/", {
      externalReservationId: "HRS-1002",
      guest: { firstName: "Leo", lastName: "Cruz" },
      roomType: "Deluxe",
      checkInDate: addDays(ctx.today, 1),
      checkOutDate: addDays(ctx.today, 3),
      numGuests: 1,
    });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("NO_AVAILABILITY");
  });

  test("unknown room type → 422", async () => {
    const res = await rsv.call("POST", "/", {
      externalReservationId: "HRS-1003",
      guest: { firstName: "Leo", lastName: "Cruz" },
      roomType: "Penthouse",
      checkInDate: ctx.today,
      checkOutDate: addDays(ctx.today, 1),
      numGuests: 1,
    });
    expect(res.status).toBe(422);
  });

  test("modification is synchronised (dates + payment status)", async () => {
    const res = await rsv.call("PATCH", "/HRS-1001", { checkOutDate: addDays(ctx.today, 3), paymentStatus: "DEPOSIT_PAID" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ checkOutDate: addDays(ctx.today, 3), paymentStatus: "DEPOSIT_PAID" });
    expect(res.data.lastSyncedAt).toBeTruthy();
  });

  test("an unknown external id → 404", async () => {
    const res = await rsv.call("GET", "/HRS-NOPE");
    expect(res.status).toBe(404);
  });

  test("cancellation is synchronised and frees the room", async () => {
    const created = await rsv.call("POST", "/", {
      externalReservationId: "HRS-2001",
      guest: { firstName: "Ana", lastName: "Lim" },
      roomType: "Family",
      checkInDate: addDays(ctx.today, 5),
      checkOutDate: addDays(ctx.today, 6),
      numGuests: 3,
    });
    expect(created.status).toBe(201);
    const cancel = await rsv.call("POST", "/HRS-2001/cancel", { reason: "Guest cancelled online" });
    expect(cancel.status).toBe(200);
    expect(cancel.data.status).toBe("CANCELLED");
    const again = await rsv.call("POST", "/HRS-2001/cancel", { reason: "again" });
    expect(again.status).toBe(409);
    const avail = await rsv.call("GET", `/availability?checkInDate=${addDays(ctx.today, 5)}&checkOutDate=${addDays(ctx.today, 6)}&roomType=Family`);
    expect(avail.data.roomTypes[0].availableRooms).toBe(1);
  });
});

describe("Reservation-based check-in + POS folio charges (simulated)", () => {
  test("front desk checks in the external reservation", async () => {
    const r = (await desk.get(`/reservations/${ctx.ext.data.pmsReservationCode}`)).data;
    const rooms = await desk.get(`/reservations/${r.id}/assignable-rooms`);
    await desk.put(`/reservations/${r.id}/room`, { roomId: rooms.data[0].id });
    await desk.post("/verifications", {
      reservationId: r.id, idType: "NATIONAL_ID", idNumberLast4: "5566", nameOnId: "Maria Santos", expiryDate: "2032-01-01", photoMatches: true,
    });
    const stay = await desk.post("/check-ins", { reservationId: r.id });
    expect(stay.status).toBe(201);
    ctx.stay = stay.data;
    ctx.roomNumber = stay.data.reservation.room.roomNumber;
  });

  test("POS looks up the in-house guest (masked name only)", async () => {
    const res = await pos.call("GET", `/in-house?roomNumber=${ctx.roomNumber}`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ folioId: ctx.stay.id, guestDisplayName: "M. Santos", folioOpen: true });
    expect(JSON.stringify(res.data)).not.toMatch(/maria@example\.com/);
  });

  test("POS on an empty room → 404", async () => {
    const res = await pos.call("GET", "/in-house?roomNumber=101");
    expect(res.status).toBe(404);
    expect(res.error.code).toBe("NO_IN_HOUSE_GUEST");
  });

  test("POS posts a restaurant charge to the room folio", async () => {
    const res = await pos.call("POST", "/charges", {
      externalTransactionId: "POS-TXN-0001",
      roomNumber: ctx.roomNumber,
      guestLastName: "santos",
      outlet: "Lobby Restaurant",
      category: "FOOD",
      description: "Dinner",
      amount: 850.5,
      transactionAt: new Date().toISOString(),
      items: [
        { name: "Adobo", quantity: 2, unitPrice: 320.25 },
        { name: "Iced tea", quantity: 2, unitPrice: 105 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ externalTransactionId: "POS-TXN-0001", folioId: ctx.stay.id, amount: 850.5 });
    ctx.charge = res;
  });

  test("same key with a changed body → 422; same transaction under a new key → 409 duplicate", async () => {
    const body = {
      externalTransactionId: "POS-TXN-0001", roomNumber: ctx.roomNumber, guestLastName: "santos", outlet: "Lobby Restaurant",
      category: "FOOD", description: "Dinner", amount: 850.5, transactionAt: "2020-01-01T00:00:00.000Z",
    };
    const replay = await pos.call("POST", "/charges", body, { key: ctx.charge.key });
    expect(replay.status).toBe(422); // body differs from the original → key reuse is rejected
    const dup = await pos.call("POST", "/charges", body);
    expect(dup.status).toBe(409);
    expect(dup.error.code).toBe("DUPLICATE_TRANSACTION");
  });

  test("items that do not add up to the amount → 422", async () => {
    const res = await pos.call("POST", "/charges", {
      externalTransactionId: "POS-TXN-0002", roomNumber: ctx.roomNumber, category: "BEVERAGE", description: "Bar",
      amount: 100, transactionAt: new Date().toISOString(), items: [{ name: "Beer", quantity: 1, unitPrice: 90 }],
    });
    expect(res.status).toBe(422);
  });

  test("wrong guest name → 409 GUEST_MISMATCH", async () => {
    const res = await pos.call("POST", "/charges", {
      externalTransactionId: "POS-TXN-0003", roomNumber: ctx.roomNumber, guestLastName: "Reyes", category: "SPA", description: "Massage",
      amount: 1200, transactionAt: new Date().toISOString(),
    });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("GUEST_MISMATCH");
  });

  test("the POS charge appears on the bill together with room charges", async () => {
    const res = await desk.post("/bills", { stayId: ctx.stay.id });
    expect(res.status).toBe(201);
    expect(res.data.charges).toHaveLength(1);
    expect(res.data.bill.totals).toMatchObject({ roomCharge: 3500, chargesTotal: 850.5, totalDue: 4350.5 });
    ctx.billId = res.data.bill.id;
  });

  test("after the bill is confirmed the folio is closed to new POS charges", async () => {
    await desk.post(`/bills/${ctx.billId}/confirm`);
    const res = await pos.call("POST", "/charges", {
      externalTransactionId: "POS-TXN-0004", roomNumber: ctx.roomNumber, category: "MINIBAR", description: "Water",
      amount: 60, transactionAt: new Date().toISOString(),
    });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("FOLIO_CLOSED");
    const status = await pos.call("GET", "/charges/POS-TXN-0001");
    expect(status.status).toBe(200);
  });

  test("checkout emits signed webhooks to the reservation system", async () => {
    await desk.post("/payments", { billId: ctx.billId, method: "CARD", amount: 4350.5, paymentToken: "tok_approve_visa" });
    const out = await desk.post("/checkouts", { stayId: ctx.stay.id });
    expect(out.status).toBe(201);

    await processOutbox();
    const events = received.map((r) => JSON.parse(r.body).event);
    expect(events).toEqual(expect.arrayContaining(["reservation.checked_in", "reservation.checked_out"]));
    // Changes made BY the reservation system (its PATCH) are not echoed back to it;
    // the only update it receives is the front desk's room assignment.
    const updates = received.map((r) => JSON.parse(r.body)).filter((e) => e.event === "reservation.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ origin: "PMS", roomNumber: ctx.roomNumber });

    const last = received.at(-1);
    const expected = `sha256=${crypto.createHmac("sha256", process.env.RESERVATION_WEBHOOK_SECRET).update(`${last.headers["x-pms-timestamp"]}.${last.body}`).digest("hex")}`;
    expect(last.headers["x-pms-signature"]).toBe(expected);
    expect(JSON.parse(last.body).data).toMatchObject({ externalReservationId: "HRS-1001", status: "CHECKED_OUT" });

    // POS has no webhook URL configured in tests → its events are recorded as SKIPPED.
    expect(await IntegrationOutbox.count({ where: { target: "POS", status: "SKIPPED" } })).toBeGreaterThanOrEqual(2);
  });
});
