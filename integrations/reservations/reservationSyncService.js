/**
 * Hotel Reservation System integration. External bookings are stored as
 * normal reservations (source = RESERVATION_SYSTEM) and identified by the
 * external system's own id (externalReservationId), never by our primary key.
 * All business rules (dates, capacity, per-night availability with row locks)
 * are the same ones the front desk uses — see services/reservationService.js.
 */
import { Reservation, RESERVATION_SOURCE } from "../../models/index.js";
import { conflict, notFound } from "../../utils/errors.js";
import { withTransaction } from "../../services/tx.js";
import { createReservation, updateReservation, cancelReservation } from "../../services/reservationService.js";
import { availabilityByType, assertValidDates } from "../../services/availabilityService.js";
import { listRoomTypes } from "../../services/roomService.js";

const SOURCE = RESERVATION_SOURCE.RESERVATION_SYSTEM;

/** External view: references and status only (the booking system already owns the guest data). */
export const externalView = (r) => ({
  externalReservationId: r.externalReservationId,
  bookingReference: r.bookingReference,
  pmsReservationCode: r.reservationCode,
  status: r.status,
  roomType: r.roomType,
  roomNumber: r.room ? r.room.roomNumber : null,
  checkInDate: r.checkInDate,
  checkOutDate: r.checkOutDate,
  numGuests: r.numGuests,
  paymentStatus: r.externalPaymentStatus,
  cancelledAt: r.cancelledAt,
  lastSyncedAt: r.lastSyncedAt,
});

const findExternal = async (externalReservationId, transaction) => {
  const r = await Reservation.findOne({ where: { source: SOURCE, externalReservationId }, include: ["room"], transaction });
  if (!r) throw notFound("Reservation");
  return r;
};

export async function createFromExternal(input) {
  return withTransaction(null, async (t) => {
    const existing = await Reservation.findOne({
      where: { source: SOURCE, externalReservationId: input.externalReservationId },
      include: ["room"],
      transaction: t,
    });
    if (existing) {
      throw conflict("DUPLICATE_RESERVATION", "A reservation with this externalReservationId already exists.", externalView(existing));
    }
    const reservation = await createReservation(
      {
        guest: input.guest,
        roomType: input.roomType,
        checkInDate: input.checkInDate,
        checkOutDate: input.checkOutDate,
        numGuests: input.numGuests,
        externalReservationId: input.externalReservationId,
        bookingReference: input.bookingReference,
        externalPaymentStatus: input.paymentStatus,
        notes: input.notes,
      },
      { source: SOURCE, transaction: t }
    );
    return externalView(reservation);
  });
}

export const getExternal = async (externalReservationId) => externalView(await findExternal(externalReservationId));

export async function updateFromExternal(externalReservationId, input) {
  return withTransaction(null, async (t) => {
    const reservation = await findExternal(externalReservationId, t);
    if (input.guest) {
      const guest = await reservation.getGuest({ transaction: t });
      await guest.update(input.guest, { transaction: t });
    }
    const changes = {};
    for (const key of ["roomType", "checkInDate", "checkOutDate", "numGuests", "bookingReference", "notes"]) {
      if (input[key] !== undefined) changes[key] = input[key];
    }
    if (input.paymentStatus !== undefined) changes.externalPaymentStatus = input.paymentStatus;
    await updateReservation({ id: reservation.id }, changes, { transaction: t, syncedFromExternal: true });
    return externalView(await findExternal(externalReservationId, t));
  });
}

export async function cancelFromExternal(externalReservationId, reason) {
  return withTransaction(null, async (t) => {
    const reservation = await findExternal(externalReservationId, t);
    await cancelReservation({ id: reservation.id }, reason, { transaction: t, syncedFromExternal: true });
    return externalView(await findExternal(externalReservationId, t));
  });
}

export async function availability({ checkInDate, checkOutDate, roomType }) {
  assertValidDates({ checkInDate, checkOutDate });
  return { checkInDate, checkOutDate, roomTypes: await availabilityByType({ checkInDate, checkOutDate, roomType }) };
}

export const roomTypes = () => listRoomTypes();
