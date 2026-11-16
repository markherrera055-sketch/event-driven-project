/**
 * Receipt and Checkout module (REQ-7: "issue a receipt after payment, then save
 * the checkout") and Room Status (room OCCUPIED → DIRTY at checkout).
 * Checkout = save checkout on the stay + reservation CHECKED_OUT + room DIRTY,
 * all in one transaction, and only once the bill is PAID. The room does NOT
 * become AVAILABLE here: RoomVacated is published so the Housekeeping System
 * creates a cleaning task, and the room becomes ready only when housekeeping
 * reports the cleaning completed (or the front desk marks it clean).
 * Publishes GuestCheckedOut (with the final folio summary) and RoomVacated.
 */
import { Stay, Bill, Receipt, BILL_STATUS, STAY_STATUS, RESERVATION_STATUS, ROOM_STATUS, STATUS_CHANGE_SOURCE } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { transition, lockRoomRow, STATUS_REASON } from "./roomStatusService.js";
import { getStay } from "./stayService.js";
import { getBillTotals } from "./billingService.js";
import { getFolio } from "./folioService.js";
import { guestCheckedOutData, roomVacatedData } from "./eventPayloads.js";
import { withTransaction } from "./tx.js";
import { emit, EVENTS } from "./domainEvents.js";
import { guestJSON, roomJSON, paymentJSON, adjustmentJSON, chargeJSON, receiptJSON, userRef } from "./serializers.js";
import { logger } from "../utils/logger.js";

export async function processCheckout(stayId, actor) {
  await withTransaction(null, async (t) => {
    const stay = await Stay.findByPk(stayId, {
      include: [{ association: "reservation", include: ["room", "guest"] }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Stay },
    });
    if (!stay) throw notFound("Stay");
    if (stay.status !== STAY_STATUS.IN_HOUSE) throw conflict("ALREADY_CHECKED_OUT", "This stay is already checked out.");

    const bill = await Bill.findOne({ where: { stayId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!bill || bill.status !== BILL_STATUS.PAID) {
      throw conflict("BILL_NOT_PAID", "The final bill must be generated and paid before checkout.");
    }

    const { reservation } = stay;
    const checkOutAt = new Date();
    await stay.update({ status: STAY_STATUS.CHECKED_OUT, checkOutAt, checkedOutBy: actor.id }, { transaction: t });
    await reservation.update({ status: RESERVATION_STATUS.CHECKED_OUT }, { transaction: t });
    const room = await lockRoomRow(reservation.roomId, t);
    await transition(
      room,
      ROOM_STATUS.DIRTY,
      { reason: STATUS_REASON.CHECKOUT, source: STATUS_CHANGE_SOURCE.FRONT_DESK, actor, reference: reservation.reservationCode },
      t
    );

    const folio = await getFolio(stay.id, { transaction: t });
    await emit(EVENTS.GUEST_CHECKED_OUT, guestCheckedOutData(stay, reservation, room, reservation.guest, folio), { transaction: t });
    await emit(EVENTS.ROOM_VACATED, roomVacatedData({ reservation, stay, room, at: checkOutAt, reason: "CHECKOUT" }), { transaction: t });
    logger.info("checkout", { stayId, reservationId: reservation.id, roomId: room.id, balance: folio.totals.balance, by: actor.id });
  });
  return getStay(stayId);
}

/** Full receipt document (printable): receipt + payment + itemised bill. */
export async function getReceipt(id) {
  const receipt = await Receipt.findByPk(id, {
    include: [
      {
        association: "payment",
        include: [
          { association: "receiver", attributes: ["id", "fullName", "role"] },
          {
            association: "bill",
            include: [
              "adjustments",
              { association: "stay", include: ["charges", { association: "reservation", include: ["guest", "room"] }] },
            ],
          },
        ],
      },
    ],
  });
  if (!receipt) throw notFound("Receipt");
  const { payment } = receipt;
  const { bill } = payment;
  const { stay } = bill;
  return {
    ...receiptJSON(receipt),
    payment: paymentJSON(payment),
    receivedBy: userRef(payment.receiver),
    reservationCode: stay.reservation.reservationCode,
    guest: guestJSON(stay.reservation.guest),
    room: roomJSON(stay.reservation.room),
    stay: { id: stay.id, checkInAt: stay.checkInAt, checkOutAt: stay.checkOutAt },
    bill: {
      id: bill.id,
      nights: bill.nights,
      nightlyRate: Number(bill.nightlyRate),
      roomCharge: Number(bill.roomCharge),
      status: bill.status,
      adjustments: bill.adjustments.map(adjustmentJSON),
      charges: stay.charges.map(chargeJSON),
      totals: await getBillTotals(bill.id),
    },
  };
}
