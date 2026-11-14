/**
 * Billing module (DFD 6.0 Generate Final Bill, 7.0 Adjust Bill; REQ-5):
 * "The system shall generate the final bill and allow corrections before payment."
 *
 * Lifecycle (BillStatus): DRAFT —confirm→ CONFIRMED —successful payment→ PAID.
 * While DRAFT the bill can be regenerated and adjusted (the "Adjust bill →
 * Generate final bill" loop in the activity diagram).
 */
import { QueryTypes } from "sequelize";
import { sequelize, Stay, Bill, BillAdjustment, Room, BILL_STATUS, STAY_STATUS } from "../models/index.js";
import { conflict, notFound, validationError } from "../utils/errors.js";
import { hotelDate, today, nightsBetween } from "../utils/dates.js";
import { multiplyMoney, toCents, fromCents } from "../utils/money.js";
import { adjustmentJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

/** Reads the authoritative totals from the v_bill_total view. */
export async function getBillTotals(billId, transaction) {
  const [row] = await sequelize.query(
    "SELECT room_charge, charges_total, adjustments_total, total_due FROM v_bill_total WHERE bill_id = :billId",
    { replacements: { billId }, type: QueryTypes.SELECT, transaction }
  );
  if (!row) throw notFound("Bill");
  return {
    roomCharge: Number(row.room_charge),
    chargesTotal: Number(row.charges_total),
    adjustmentsTotal: Number(row.adjustments_total),
    totalDue: Number(row.total_due),
  };
}

/** Stay.getNights(): nights from check-in date to today (minimum 1 — a same-day stay is billed one night). */
export const nightsStayed = (stay) => Math.max(1, nightsBetween(hotelDate(new Date(stay.checkInAt)), today()));

/** Bill.generateFinalBill(): creates or recalculates the DRAFT bill for an in-house stay. */
export async function generateFinalBill(stayId, actor) {
  return withTransaction(null, async (t) => {
    const stay = await Stay.findByPk(stayId, {
      include: [{ association: "reservation", include: [{ model: Room, as: "room" }] }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Stay },
    });
    if (!stay) throw notFound("Stay");
    if (stay.status !== STAY_STATUS.IN_HOUSE) throw conflict("STAY_NOT_IN_HOUSE", "This stay is already checked out.");

    const room = stay.reservation.room;
    const nights = nightsStayed(stay);
    const nightlyRate = Number(room.nightlyRate);
    const values = {
      nights,
      nightlyRate,
      roomCharge: multiplyMoney(nightlyRate, nights),
      generatedBy: actor.id,
      generatedAt: new Date(),
    };

    let bill = await Bill.findOne({ where: { stayId }, transaction: t, lock: t.LOCK.UPDATE });
    if (bill && bill.status !== BILL_STATUS.DRAFT) {
      throw conflict("BILL_LOCKED", `The bill is already ${bill.status}; it can no longer be regenerated.`);
    }
    if (bill) await bill.update(values, { transaction: t });
    else bill = await Bill.create({ ...values, stayId, status: BILL_STATUS.DRAFT }, { transaction: t });

    logger.info("bill_generated", { billId: bill.id, stayId, nights, roomCharge: values.roomCharge, by: actor.id });
    return bill.id;
  });
}

const lockBill = async (billId, t) => {
  const bill = await Bill.findByPk(billId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!bill) throw notFound("Bill");
  return bill;
};

/** Bill.adjust(amount, reason): signed correction while the bill is still DRAFT. */
export async function adjustBill(billId, { amount, reason }, actor) {
  return withTransaction(null, async (t) => {
    const bill = await lockBill(billId, t);
    if (bill.status !== BILL_STATUS.DRAFT) {
      throw conflict("BILL_LOCKED", "Adjustments are only allowed while the bill is a draft.");
    }
    const { totalDue } = await getBillTotals(bill.id, t);
    if (toCents(totalDue) + toCents(amount) < 0) {
      throw validationError({ amount: `The adjustment would make the total negative (current total ${totalDue.toFixed(2)}).` });
    }
    const adjustment = await BillAdjustment.create(
      { billId: bill.id, amount, reason, adjustedBy: actor.id, adjustedAt: new Date() },
      { transaction: t }
    );
    logger.info("bill_adjusted", { billId: bill.id, amount, by: actor.id });
    return { adjustment: adjustmentJSON(adjustment), totals: await getBillTotals(bill.id, t) };
  });
}

/** Bill.confirm(): the receptionist confirms the bill is correct; it becomes payable and frozen. */
export async function confirmBill(billId, actor) {
  return withTransaction(null, async (t) => {
    const bill = await lockBill(billId, t);
    if (bill.status !== BILL_STATUS.DRAFT) throw conflict("BILL_NOT_DRAFT", `The bill is already ${bill.status}.`);
    const totals = await getBillTotals(bill.id, t);
    if (toCents(totals.totalDue) <= 0) {
      throw conflict("BILL_TOTAL_ZERO", "The total due must be greater than zero to take payment.");
    }
    await bill.update({ status: BILL_STATUS.CONFIRMED, confirmedAt: new Date() }, { transaction: t });
    logger.info("bill_confirmed", { billId: bill.id, totalDue: totals.totalDue, by: actor.id });
    return { id: bill.id, status: bill.status, totals };
  });
}

export const billBalanceCents = async (billId, t) => toCents((await getBillTotals(billId, t)).totalDue);
export { fromCents };
