/**
 * TC-1 … TC-7 (Figure 17): the full front-desk workflow of the sequence diagram
 * (Figure 12), using the object-diagram example (Figure 5): Juan Dela Cruz,
 * Deluxe room 204 at 3,500/night, a -500 rate correction, a failed card
 * attempt followed by a successful payment, receipt, checkout.
 */
import { resetDatabase, startApp, StaffClient, PASSWORDS } from "./helpers/harness.js";
import { Room } from "../models/index.js";

let app;
let desk;
const ctx = {};

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
});
afterAll(() => app?.close());

describe("TC-1 Display reservation (steps 1-5)", () => {
  test("walk-in reservation is created as CONFIRMED with a reservation code", async () => {
    const today = (await desk.get("/me")).data.hotel.today;
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const res = await desk.post("/reservations", {
      guest: { firstName: "Juan", lastName: "Dela Cruz", phone: "0917-000-0000", email: "juan@example.com" },
      roomType: "Deluxe",
      checkInDate: today,
      checkOutDate: tomorrow,
      numGuests: 2,
    });
    expect(res.status).toBe(201);
    expect(res.data.reservationCode).toMatch(/^RSV-\d{4}$/);
    expect(res.data.status).toBe("CONFIRMED");
    expect(res.data.room).toBeNull();
    Object.assign(ctx, { reservation: res.data, today, tomorrow });
  });

  test("GET /reservations/{code} returns reservation, guest and room", async () => {
    const res = await desk.get(`/reservations/${ctx.reservation.reservationCode}`);
    expect(res.status).toBe(200);
    expect(res.data.guest.fullName).toBe("Juan Dela Cruz");
    expect(res.data.identityVerified).toBe(false);
  });

  test("search finds the reservation by guest name", async () => {
    const res = await desk.get("/reservations?search=Dela%20Cruz");
    expect(res.status).toBe(200);
    expect(res.data.map((r) => r.id)).toContain(ctx.reservation.id);
  });

  test("the same guest is reused, not duplicated (matched by email)", async () => {
    const res = await desk.post("/reservations", {
      guest: { firstName: "Juan", lastName: "Dela Cruz", email: "JUAN@example.com" },
      roomType: "Standard",
      checkInDate: ctx.today,
      checkOutDate: ctx.tomorrow,
      numGuests: 1,
    });
    expect(res.status).toBe(201);
    expect(res.data.guest.id).toBe(ctx.reservation.guest.id);
  });

  test("invalid input is rejected with field errors", async () => {
    const res = await desk.post("/reservations", { guest: { firstName: "" }, roomType: "Deluxe", checkInDate: "2026-02-30", numGuests: 0 });
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.error.details)).toEqual(expect.arrayContaining(["checkInDate", "checkOutDate", "numGuests"]));
  });
});

describe("TC-2 Verify guest identity (steps 6-10)", () => {
  test("check-in is refused before a room is assigned", async () => {
    const res = await desk.post("/check-ins", { reservationId: ctx.reservation.id });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("ROOM_NOT_ASSIGNED");
  });

  test("room 204 is assignable and gets assigned", async () => {
    const rooms = await desk.get(`/reservations/${ctx.reservation.id}/assignable-rooms`);
    const room204 = rooms.data.find((r) => r.roomNumber === "204");
    expect(room204).toBeDefined();
    const res = await desk.put(`/reservations/${ctx.reservation.id}/room`, { roomId: room204.id });
    expect(res.status).toBe(200);
    expect(res.data.room.roomNumber).toBe("204");
    ctx.room = room204;
  });

  test("check-in is refused before identity is verified", async () => {
    const res = await desk.post("/check-ins", { reservationId: ctx.reservation.id });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("IDENTITY_NOT_VERIFIED");
  });

  test("attempt 1 FAILS (name on ID does not match) and is recorded", async () => {
    const res = await desk.post("/verifications", {
      reservationId: ctx.reservation.id,
      idType: "DRIVERS_LICENSE",
      idNumberLast4: "1234",
      nameOnId: "Pedro Santos",
      expiryDate: "2030-01-01",
      photoMatches: true,
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ attemptNo: 1, result: "FAILED" });
    expect(res.data.failureReason).toMatch(/Name on ID/);
  });

  test("attempt 2 with a passport is VERIFIED; only the last 4 characters are stored", async () => {
    const res = await desk.post("/verifications", {
      reservationId: ctx.reservation.id,
      idType: "PASSPORT",
      idNumberLast4: "a9z8",
      nameOnId: "JUAN MIGUEL DELA CRUZ",
      expiryDate: "2031-05-01",
      photoMatches: true,
    });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ attemptNo: 2, result: "VERIFIED", idNumberLast4: "A9Z8" });
    const list = await desk.get(`/reservations/${ctx.reservation.id}/verifications`);
    expect(list.data.map((v) => v.result)).toEqual(["FAILED", "VERIFIED"]);
  });
});

describe("TC-3 / TC-4 Check in guest + room status (steps 11-14, 13)", () => {
  test("check-in creates the stay, marks reservation CHECKED_IN and room OCCUPIED", async () => {
    const res = await desk.post("/check-ins", { reservationId: ctx.reservation.id });
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("IN_HOUSE");
    expect(res.data.reservation.status).toBe("CHECKED_IN");
    expect(res.data.checkedInBy.fullName).toBe("Liza Ramos");
    const room = await Room.findByPk(ctx.room.id);
    expect(room.status).toBe("OCCUPIED");
    ctx.stay = res.data;
  });

  test("checking in twice is refused", async () => {
    const res = await desk.post("/check-ins", { reservationId: ctx.reservation.id });
    expect(res.status).toBe(409);
  });
});

describe("TC-5 Generate and adjust bill (steps 15-22)", () => {
  test("checkout before the bill is paid is refused", async () => {
    const res = await desk.post("/checkouts", { stayId: ctx.stay.id });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("BILL_NOT_PAID");
  });

  test("final bill is generated as DRAFT (nights x nightly rate)", async () => {
    const res = await desk.post("/bills", { stayId: ctx.stay.id });
    expect(res.status).toBe(201);
    const bill = res.data.bill;
    expect(bill.status).toBe("DRAFT");
    expect(bill.nights).toBe(1);
    expect(bill.nightlyRate).toBe(3500);
    expect(bill.totals.totalDue).toBe(3500);
    ctx.bill = bill;
  });

  test("an adjustment of -500 (rate correction) updates the total", async () => {
    const res = await desk.post(`/bills/${ctx.bill.id}/adjustments`, { amount: "-500.00", reason: "Rate correction" });
    expect(res.status).toBe(201);
    expect(res.data.totals.totalDue).toBe(3000);
  });

  test("an adjustment that makes the total negative is rejected", async () => {
    const res = await desk.post(`/bills/${ctx.bill.id}/adjustments`, { amount: -99999, reason: "Too much" });
    expect(res.status).toBe(422);
  });

  test("regenerating the draft keeps adjustments", async () => {
    const res = await desk.post("/bills", { stayId: ctx.stay.id });
    expect(res.data.bill.totals.totalDue).toBe(3000);
    expect(res.data.bill.adjustments).toHaveLength(1);
  });

  test("payment before confirmation is refused", async () => {
    const res = await desk.post("/payments", { billId: ctx.bill.id, method: "CASH", amount: 3000 });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("BILL_NOT_CONFIRMED");
  });

  test("bill is confirmed; it can no longer be adjusted", async () => {
    const res = await desk.post(`/bills/${ctx.bill.id}/confirm`);
    expect(res.status).toBe(200);
    expect(res.data.status).toBe("CONFIRMED");
    const adj = await desk.post(`/bills/${ctx.bill.id}/adjustments`, { amount: -10, reason: "Late change" });
    expect(adj.status).toBe(409);
  });
});

describe("TC-6 Process payment with retry (steps 23-29)", () => {
  test("amount that differs from the total is refused", async () => {
    const res = await desk.post("/payments", { billId: ctx.bill.id, method: "CASH", amount: 2999.99 });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("AMOUNT_MISMATCH");
  });

  test("attempt 1 by CARD is declined by the gateway and recorded as FAILED", async () => {
    const res = await desk.post("/payments", { billId: ctx.bill.id, method: "CARD", amount: 3000, paymentToken: "tok_decline_insufficient" });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ attemptNo: 1, status: "FAILED", receipt: null });
    expect(res.data.failureReason).toMatch(/declined/i);
  });

  test("attempt 2 in CASH succeeds, issues a receipt and marks the bill PAID", async () => {
    const res = await desk.post("/payments", { billId: ctx.bill.id, method: "CASH", amount: 3000 });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ attemptNo: 2, status: "SUCCESSFUL", amount: 3000 });
    expect(res.data.receipt.receiptNo).toMatch(/^OR-\d{6}$/);
    ctx.receipt = res.data.receipt;
  });

  test("a second payment for a paid bill is refused (no double charge)", async () => {
    const res = await desk.post("/payments", { billId: ctx.bill.id, method: "CASH", amount: 3000 });
    expect(res.status).toBe(409);
    expect(res.error.code).toBe("BILL_ALREADY_PAID");
  });
});

describe("TC-7 Receipt and checkout (steps 30-36)", () => {
  test("receipt shows the itemised bill", async () => {
    const res = await desk.get(`/receipts/${ctx.receipt.id}`);
    expect(res.status).toBe(200);
    expect(res.data.bill.totals).toMatchObject({ roomCharge: 3500, adjustmentsTotal: -500, totalDue: 3000 });
    expect(res.data.guest.fullName).toBe("Juan Dela Cruz");
  });

  test("checkout saves the stay, marks reservation CHECKED_OUT and room VACANT (needs cleaning)", async () => {
    const res = await desk.post("/checkouts", { stayId: ctx.stay.id });
    expect(res.status).toBe(201);
    expect(res.data.status).toBe("CHECKED_OUT");
    expect(res.data.checkedOutBy.fullName).toBe("Liza Ramos");
    const reservation = await desk.get(`/reservations/${ctx.reservation.id}`);
    expect(reservation.data.status).toBe("CHECKED_OUT");
    const room = await Room.findByPk(ctx.room.id);
    expect(room.status).toBe("VACANT");
    expect(room.needsCleaning).toBe(true);
  });

  test("housekeeping marks the room clean", async () => {
    const res = await desk.post(`/rooms/${ctx.room.id}/clean`);
    expect(res.status).toBe(200);
    expect(res.data.needsCleaning).toBe(false);
    expect(res.data.lastCleanedAt).toBeTruthy();
  });

  test("dashboard and report reflect the day's activity", async () => {
    const dash = await desk.get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.data.revenueToday).toBe(3000);
    expect(dash.data.recentPayments.length).toBeGreaterThanOrEqual(2);
    const report = await desk.get(`/reports/summary?from=${ctx.today}&to=${ctx.today}`);
    expect(report.status).toBe(200);
    expect(report.data.summary).toMatchObject({ checkIns: 1, checkOuts: 1, revenue: 3000, successfulPayments: 1, failedPayments: 1 });
  });
});

describe("Overbooking protection", () => {
  test("a second overlapping booking of the only Deluxe room is refused", async () => {
    const make = () =>
      desk.post("/reservations", {
        guest: { firstName: "Ana", lastName: "Reyes" },
        roomType: "Deluxe",
        checkInDate: ctx.tomorrow,
        checkOutDate: new Date(Date.parse(`${ctx.tomorrow}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10),
        numGuests: 2,
      });
    const [a, b] = await Promise.all([make(), make()]); // concurrent: the row lock serialises them
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409).error.code).toBe("NO_AVAILABILITY");
  });

  test("more guests than the room type holds is refused", async () => {
    const res = await desk.post("/reservations", {
      guest: { firstName: "Big", lastName: "Group" },
      roomType: "Standard",
      checkInDate: ctx.today,
      checkOutDate: ctx.tomorrow,
      numGuests: 5,
    });
    expect(res.status).toBe(422);
    expect(res.error.details.numGuests).toBeDefined();
  });
});
