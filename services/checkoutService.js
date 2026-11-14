/**
 * Receipt and Checkout module (REQ-7: "issue a receipt after payment, then save
 * the checkout") and Room Status (REQ-4: room Vacant at checkout).
 * Checkout = save checkout on the stay + reservation CHECKED_OUT + room VACANT,
 * all in one transaction, and only once the bill is PAID.
 */
import { Stay, Bill, Receipt, BILL_STATUS, STAY_STATUS, RESERVATION_STATUS } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { setVacant } from "./roomService.js";
import { getStay, stayEventPayload } from "./stayService.js";
import { getBillTotals } from "./billingService.js";
import { eventPayload } from "./reservationService.js";
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

    await stay.update(
      { status: STAY_STATUS.CHECKED_OUT, checkOutAt: new Date(), checkedOutBy: actor.id },
      { transaction: t }
    );
    await stay.reservation.update({ status: RESERVATION_STATUS.CHECKED_OUT }, { transaction: t });
    await setVacant(stay.reservation.roomId, t);

    const { reservation } = stay;
    await emit(EVENTS.RESERVATION_CHECKED_OUT, eventPayload(reservation, reservation.room), { transaction: t });
    await emit(EVENTS.STAY_CHECKED_OUT, stayEventPayload(stay, reservation, reservation.room, reservation.guest), { transaction: t });
    logger.info("checkout", { stayId, reservationId: reservation.id, roomId: reservation.roomId, by: actor.id });
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
