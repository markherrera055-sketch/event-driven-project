/**
 * POS integration — posting restaurant / bar / service charges to a guest's
 * room folio. The POS is a separate application; it only talks to the PMS
 * through the authenticated endpoints in ./routes.js.
 *
 * Rules:
 *  - The room must have an in-house stay (reservation CHECKED_IN).
 *  - Optional cross-checks: folioId and/or guestLastName must match.
 *  - The folio is open while the stay has no bill or a DRAFT bill. Once the
 *    bill is CONFIRMED / PAID, new charges are refused (FOLIO_CLOSED) so the
 *    amount the guest pays cannot change underneath the cashier.
 *  - (sourceSystem, externalTransactionId) is unique: a POS transaction can
 *    never be charged twice, even with a different Idempotency-Key.
 */
import { UniqueConstraintError } from "sequelize";
import { Stay, StayCharge, Bill, Room, Reservation, Guest, STAY_STATUS, BILL_STATUS, RESERVATION_STATUS } from "../../models/index.js";
import { AppError, conflict, notFound, validationError } from "../../utils/errors.js";
import { sumMoney, toCents } from "../../utils/money.js";
import { withTransaction } from "../../services/tx.js";
import { logger } from "../../utils/logger.js";

export const POS_SOURCE = "POS";

const displayName = (guest) => `${guest.firstName.charAt(0)}. ${guest.lastName}`;

async function findInHouseStayByRoom(roomNumber, transaction, lock = false) {
  const stay = await Stay.findOne({
    where: { status: STAY_STATUS.IN_HOUSE },
    include: [
      {
        model: Reservation,
        as: "reservation",
        required: true,
        where: { status: RESERVATION_STATUS.CHECKED_IN },
        include: [
          { model: Room, as: "room", required: true, where: { roomNumber } },
          { model: Guest, as: "guest" },
        ],
      },
    ],
    transaction,
    ...(lock ? { lock: { level: transaction.LOCK.UPDATE, of: Stay } } : {}),
  });
  if (!stay) throw new AppError(404, "NO_IN_HOUSE_GUEST", `Room ${roomNumber} has no checked-in guest.`);
  return stay;
}

const folioOpen = (bill) => !bill || bill.status === BILL_STATUS.DRAFT;

const chargeView = (charge, stay) => ({
  pmsChargeId: charge.id,
  externalTransactionId: charge.externalTransactionId,
  folioId: charge.stayId,
  roomNumber: stay?.reservation?.room?.roomNumber,
  category: charge.category,
  description: charge.description,
  amount: Number(charge.amount),
  transactionAt: charge.transactionAt,
  postedAt: charge.createdAt,
});

/** GET in-house lookup so the cashier can confirm room + guest before charging. */
export async function lookupInHouse(roomNumber) {
  const stay = await findInHouseStayByRoom(roomNumber);
  const bill = await Bill.findOne({ where: { stayId: stay.id } });
  return {
    folioId: stay.id,
    roomNumber: stay.reservation.room.roomNumber,
    guestDisplayName: displayName(stay.reservation.guest),
    checkInAt: stay.checkInAt,
    expectedCheckOutDate: stay.reservation.checkOutDate,
    folioOpen: folioOpen(bill),
  };
}

export async function postCharge(input) {
  if (input.items?.length) {
    const itemsTotal = sumMoney(...input.items.map((i) => toCents(i.unitPrice) * i.quantity / 100));
    if (toCents(itemsTotal) !== toCents(input.amount)) {
      throw validationError({ amount: `Amount (${input.amount}) does not equal the sum of items (${itemsTotal}).` });
    }
  }
  if (input.transactionAt > new Date(Date.now() + 5 * 60 * 1000)) {
    throw validationError({ transactionAt: "Transaction time cannot be in the future." });
  }

  try {
    return await withTransaction(null, async (t) => {
      const existing = await StayCharge.findOne({
        where: { sourceSystem: POS_SOURCE, externalTransactionId: input.externalTransactionId },
        transaction: t,
      });
      if (existing) {
        throw conflict("DUPLICATE_TRANSACTION", "This POS transaction was already posted.", chargeView(existing));
      }

      const stay = await findInHouseStayByRoom(input.roomNumber, t, true);
      if (input.folioId && input.folioId !== stay.id) {
        throw conflict("FOLIO_MISMATCH", "The folio does not belong to the guest currently in this room.");
      }
      if (input.guestLastName && input.guestLastName.toLowerCase() !== stay.reservation.guest.lastName.toLowerCase()) {
        throw conflict("GUEST_MISMATCH", "Guest last name does not match the guest in this room.");
      }
      const bill = await Bill.findOne({ where: { stayId: stay.id }, transaction: t, lock: t.LOCK.UPDATE });
      if (!folioOpen(bill)) {
        throw conflict("FOLIO_CLOSED", "The guest's bill is already confirmed for checkout; settle this charge directly at the POS.");
      }

      const charge = await StayCharge.create(
        {
          stayId: stay.id,
          sourceSystem: POS_SOURCE,
          externalTransactionId: input.externalTransactionId,
          outlet: input.outlet || null,
          category: input.category,
          description: input.description,
          amount: input.amount,
          items: input.items?.length ? input.items : null,
          transactionAt: input.transactionAt,
        },
        { transaction: t }
      );
      logger.info("pos_charge_posted", { chargeId: charge.id, stayId: stay.id, externalTransactionId: charge.externalTransactionId, amount: input.amount });
      return chargeView(charge, stay);
    });
  } catch (err) {
    // Two concurrent requests with the same transaction id: the unique index decides.
    if (err instanceof UniqueConstraintError) {
      throw conflict("DUPLICATE_TRANSACTION", "This POS transaction was already posted.");
    }
    throw err;
  }
}

export async function getCharge(externalTransactionId) {
  const charge = await StayCharge.findOne({
    where: { sourceSystem: POS_SOURCE, externalTransactionId },
    include: [{ association: "stay", include: [{ association: "reservation", include: ["room"] }] }],
  });
  if (!charge) throw notFound("Charge");
  return chargeView(charge, charge.stay);
}
