/**
 * Guest Folio — the running account of one stay:
 *   room charges            nights × nightly rate (from the final bill once it exists, accrued to date before that)
 *   restaurant charges      FOOD / BEVERAGE charges posted by the Restaurant POS
 *   other charges           any other authorised charge posted to the room (minibar, laundry, spa, …)
 *   adjustments             signed corrections made by the front desk on the bill (discounts, refunds before payment)
 *   payments                successful payments only (declined attempts are listed for audit, not counted)
 *   balance                 total charges − payments
 *
 * The final checkout bill is the same set of lines: v_bill_total = room charge
 * + all folio charges + adjustments, so every valid folio charge is billed
 * automatically. A charge can only be posted while the folio is open (no bill
 * yet, or a DRAFT bill); once the bill is confirmed the amount the guest pays
 * cannot change underneath the cashier.
 */
import { Stay, Bill, StayCharge, BILL_STATUS, PAYMENT_STATUS } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { toCents, fromCents, multiplyMoney } from "../utils/money.js";
import { config } from "../config/index.js";
import { nightsStayed } from "./billingService.js";
import { emit, EVENTS } from "./domainEvents.js";
import { roomChargePostedData, guestFolioUpdatedData } from "./eventPayloads.js";

export const RESTAURANT_CATEGORIES = Object.freeze(["FOOD", "BEVERAGE"]);

export const FOLIO_LINE = Object.freeze({
  ROOM: "ROOM",
  RESTAURANT: "RESTAURANT",
  OTHER_CHARGE: "OTHER_CHARGE",
  ADJUSTMENT: "ADJUSTMENT",
  PAYMENT: "PAYMENT",
});

export const isFolioOpen = (bill) => !bill || bill.status === BILL_STATUS.DRAFT;

const folioInclude = [
  { association: "reservation", include: ["room", "guest"] },
  "charges",
  { association: "bill", include: ["adjustments", "payments"] },
];

/** Builds the statement from a stay loaded with folioInclude. Pure: no queries. */
export function buildFolio(stay) {
  const { reservation } = stay;
  const room = reservation.room;
  const bill = stay.bill || null;

  const roomLine = bill
    ? { nights: bill.nights, nightlyRate: Number(bill.nightlyRate), amount: Number(bill.roomCharge), basis: "BILLED" }
    : (() => {
        const nights = nightsStayed(stay);
        return { nights, nightlyRate: Number(room.nightlyRate), amount: multiplyMoney(room.nightlyRate, nights), basis: "ACCRUED_TO_DATE" };
      })();

  const lines = [
    {
      type: FOLIO_LINE.ROOM,
      description: `Room ${room.roomNumber} — ${roomLine.nights} night(s) × ${roomLine.nightlyRate.toFixed(2)}`,
      amount: roomLine.amount,
      date: bill ? bill.generatedAt : stay.checkInAt,
      reference: bill ? `BILL-${bill.id}` : null,
    },
  ];

  let restaurant = 0;
  let other = 0;
  for (const c of stay.charges || []) {
    const isRestaurant = RESTAURANT_CATEGORIES.includes(c.category);
    if (isRestaurant) restaurant += toCents(c.amount);
    else other += toCents(c.amount);
    lines.push({
      type: isRestaurant ? FOLIO_LINE.RESTAURANT : FOLIO_LINE.OTHER_CHARGE,
      description: c.outlet ? `${c.outlet}: ${c.description}` : c.description,
      amount: Number(c.amount),
      date: c.transactionAt,
      reference: c.externalTransactionId,
      sourceSystem: c.sourceSystem,
      category: c.category,
    });
  }

  let adjustments = 0;
  for (const a of bill?.adjustments || []) {
    adjustments += toCents(a.amount);
    lines.push({ type: FOLIO_LINE.ADJUSTMENT, description: a.reason, amount: Number(a.amount), date: a.adjustedAt, reference: `ADJ-${a.id}` });
  }

  let paid = 0;
  const failedPayments = [];
  for (const p of bill?.payments || []) {
    if (p.status !== PAYMENT_STATUS.SUCCESSFUL) {
      failedPayments.push({ attemptNo: p.attemptNo, method: p.method, amount: Number(p.amount), reason: p.failureReason, date: p.processedAt });
      continue;
    }
    paid += toCents(p.amount);
    // Payments reduce the balance, so they are shown as negative lines.
    lines.push({ type: FOLIO_LINE.PAYMENT, description: `Payment (${p.method})`, amount: -Number(p.amount), date: p.processedAt, reference: p.gatewayReference || `PAY-${p.id}` });
  }

  lines.sort((a, b) => new Date(a.date) - new Date(b.date));
  const total = toCents(roomLine.amount) + restaurant + other + adjustments;

  return {
    stayId: stay.id,
    reservationId: reservation.id,
    reservationCode: reservation.reservationCode,
    roomNumber: room.roomNumber,
    guestName: reservation.guest ? `${reservation.guest.firstName} ${reservation.guest.lastName}` : null,
    stayStatus: stay.status,
    billId: bill?.id ?? null,
    billStatus: bill?.status ?? null,
    folioOpen: isFolioOpen(bill),
    currency: config.hotel.currency,
    room: roomLine,
    lines,
    failedPayments,
    totals: {
      roomCharges: roomLine.amount,
      restaurantCharges: fromCents(restaurant),
      otherCharges: fromCents(other),
      adjustments: fromCents(adjustments),
      totalCharges: fromCents(total),
      payments: fromCents(paid),
      balance: fromCents(total - paid),
    },
  };
}

export async function getFolio(stayId, { transaction } = {}) {
  const stay = await Stay.findByPk(stayId, { include: folioInclude, transaction });
  if (!stay) throw notFound("Stay");
  return buildFolio(stay);
}

/**
 * Posts a charge to an in-house stay's folio. The caller has already locked
 * the stay and checked who the charge is for; this enforces the folio rules
 * and publishes RoomChargePosted + GuestFolioUpdated.
 */
export async function postFolioCharge(stay, charge, transaction) {
  const bill = await Bill.findOne({ where: { stayId: stay.id }, transaction, lock: transaction.LOCK.UPDATE });
  if (!isFolioOpen(bill)) {
    throw conflict("FOLIO_CLOSED", "The guest's bill is already confirmed for checkout; settle this charge directly at the outlet.");
  }
  const row = await StayCharge.create(
    {
      stayId: stay.id,
      sourceSystem: charge.sourceSystem,
      externalTransactionId: charge.externalTransactionId,
      outlet: charge.outlet || null,
      category: charge.category,
      description: charge.description,
      amount: charge.amount,
      items: charge.items?.length ? charge.items : null,
      transactionAt: charge.transactionAt,
    },
    { transaction }
  );
  const { reservation } = stay;
  await emit(EVENTS.ROOM_CHARGE_POSTED, roomChargePostedData(row, stay, reservation, reservation.room), { transaction });
  await emit(EVENTS.GUEST_FOLIO_UPDATED, guestFolioUpdatedData(await getFolio(stay.id, { transaction }), "ROOM_CHARGE_POSTED"), { transaction });
  return row;
}
