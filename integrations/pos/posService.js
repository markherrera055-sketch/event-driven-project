/**
 * Restaurant POS (Member 4) → PMS: "Charge to room".
 *
 * The POS identifies the stay by the PMS reservation_id (from the in-house
 * lookup or the GuestCheckedIn webhook) plus the room number, and optionally
 * the guest name as the cashier typed it. The PMS checks, under row locks:
 *   - the reservation exists and is CHECKED_IN (in-house) — checked-out,
 *     cancelled or future reservations cannot be charged;
 *   - the room number is the reservation's current room;
 *   - the guest name (if sent) matches the registered guest;
 *   - the currency is the hotel currency and the items add up to the amount;
 *   - the folio is still open (bill not yet confirmed for checkout);
 *   - (POS, external_transaction_id) has never been posted — a POS
 *     transaction can never be charged twice, even with a new Idempotency-Key.
 * The charge is written to the Guest Folio and is billed at checkout.
 */
import { UniqueConstraintError } from "sequelize";
import { Stay, StayCharge, Reservation, Room, RESERVATION_STATUS, STAY_STATUS } from "../../models/index.js";
import { AppError, conflict, validationError } from "../../utils/errors.js";
import { sumMoney, toCents } from "../../utils/money.js";
import { config } from "../../config/index.js";
import { withTransaction } from "../../services/tx.js";
import { postFolioCharge, isFolioOpen } from "../../services/folioService.js";
import { logger } from "../../utils/logger.js";

export const POS_SOURCE = "POS";

const displayName = (guest) => `${guest.firstName.charAt(0)}. ${guest.lastName}`;
const normalise = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** "John Doe", "Doe John", "Doe, John" and "J. Doe" all match John Doe; the last name is always required. */
export function guestNameMatches(given, guest) {
  const words = normalise(given);
  const last = normalise(guest.lastName);
  const first = normalise(guest.firstName);
  if (!last.every((w) => words.includes(w))) return false;
  const rest = words.filter((w) => !last.includes(w));
  return rest.length === 0 || rest.every((w) => first.includes(w) || (w.length === 1 && first.some((f) => f.startsWith(w))));
}

const chargeView = (charge, reservation, room) => ({
  charge_id: charge.id,
  external_transaction_id: charge.externalTransactionId,
  status: "POSTED",
  reservation_id: reservation?.id ?? null,
  stay_id: charge.stayId,
  room_number: room?.roomNumber ?? null,
  category: charge.category,
  description: charge.description,
  amount: Number(charge.amount),
  currency: config.hotel.currency,
  items: (charge.items || []).map((i) => ({ name: i.name, quantity: i.quantity, unit_price: Number(i.unitPrice ?? i.unit_price) })),
  transaction_date: charge.transactionAt,
  posted_at: charge.createdAt,
});

const noInHouse = (message) => new AppError(404, "NO_IN_HOUSE_GUEST", message);

/** GET lookup so the cashier can confirm room + guest before charging. Masked name only. */
export async function lookupInHouse(roomNumber) {
  const reservation = await Reservation.findOne({
    where: { status: RESERVATION_STATUS.CHECKED_IN },
    include: [{ model: Room, as: "room", required: true, where: { roomNumber } }, "guest", { association: "stay", include: ["bill"] }],
  });
  if (!reservation?.stay) throw noInHouse(`Room ${roomNumber} has no checked-in guest.`);
  return {
    reservation_id: reservation.id,
    reservation_code: reservation.reservationCode,
    stay_id: reservation.stay.id,
    room_number: reservation.room.roomNumber,
    guest_display_name: displayName(reservation.guest),
    checked_in_at: reservation.stay.checkInAt,
    expected_check_out_date: reservation.checkOutDate,
    folio_open: isFolioOpen(reservation.stay.bill),
  };
}

export async function postRoomCharge(input) {
  if (input.currency !== config.hotel.currency) {
    throw validationError({ currency: `Only ${config.hotel.currency} is accepted.` });
  }
  if (input.items?.length) {
    const itemsTotal = sumMoney(...input.items.map((i) => (toCents(i.unit_price) * i.quantity) / 100));
    if (toCents(itemsTotal) !== toCents(input.amount)) {
      throw validationError({ amount: `Amount (${input.amount}) does not equal the sum of items (${itemsTotal}).` });
    }
  }
  if (input.transaction_date > new Date(Date.now() + 5 * 60 * 1000)) {
    throw validationError({ transaction_date: "Transaction date cannot be in the future." });
  }

  try {
    return await withTransaction(null, async (t) => {
      const existing = await StayCharge.findOne({
        where: { sourceSystem: POS_SOURCE, externalTransactionId: input.external_transaction_id },
        include: [{ association: "stay", include: [{ association: "reservation", include: ["room"] }] }],
        transaction: t,
      });
      if (existing) {
        throw conflict("DUPLICATE_TRANSACTION", "This POS transaction was already posted.", chargeView(existing, existing.stay.reservation, existing.stay.reservation.room));
      }

      const reservation = await Reservation.findByPk(input.reservation_id, {
        include: ["room", "guest"],
        transaction: t,
        lock: { level: t.LOCK.UPDATE, of: Reservation },
      });
      if (!reservation) throw new AppError(404, "RESERVATION_NOT_FOUND", `Reservation ${input.reservation_id} does not exist.`);
      if (reservation.status !== RESERVATION_STATUS.CHECKED_IN) {
        throw conflict(
          "RESERVATION_NOT_ACTIVE",
          `Reservation ${reservation.reservationCode} is ${reservation.status}; only checked-in guests can charge to their room.`
        );
      }
      if (!reservation.room || reservation.room.roomNumber !== input.room_number) {
        throw conflict("ROOM_MISMATCH", `Room ${input.room_number} does not belong to reservation ${reservation.reservationCode}.`);
      }
      if (input.guest_name && !guestNameMatches(input.guest_name, reservation.guest)) {
        throw conflict("GUEST_MISMATCH", "The guest name does not match the guest registered to this reservation.");
      }
      const stay = await Stay.findOne({
        where: { reservationId: reservation.id, status: STAY_STATUS.IN_HOUSE },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!stay) throw noInHouse(`Reservation ${reservation.reservationCode} has no in-house stay.`);
      stay.reservation = reservation;

      const charge = await postFolioCharge(
        stay,
        {
          sourceSystem: POS_SOURCE,
          externalTransactionId: input.external_transaction_id,
          outlet: input.outlet,
          category: input.category || "FOOD",
          description: input.description,
          amount: input.amount,
          items: input.items?.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unit_price })),
          transactionAt: input.transaction_date,
        },
        t
      );
      logger.info("pos_charge_posted", { chargeId: charge.id, stayId: stay.id, reservationId: reservation.id, externalTransactionId: charge.externalTransactionId, amount: input.amount });
      return chargeView(charge, reservation, reservation.room);
    });
  } catch (err) {
    // Two concurrent requests with the same transaction id: the unique index decides.
    if (err instanceof UniqueConstraintError) throw conflict("DUPLICATE_TRANSACTION", "This POS transaction was already posted.");
    throw err;
  }
}

export async function getRoomCharge(externalTransactionId) {
  const charge = await StayCharge.findOne({
    where: { sourceSystem: POS_SOURCE, externalTransactionId },
    include: [{ association: "stay", include: [{ association: "reservation", include: ["room"] }] }],
  });
  if (!charge) throw new AppError(404, "NOT_FOUND", "Charge not found.");
  return chargeView(charge, charge.stay.reservation, charge.stay.reservation.room);
}
