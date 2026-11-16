/**
 * Guest Booking System (Member 1) → PMS.
 *
 * External bookings become normal PMS reservations (source RESERVATION_SYSTEM)
 * through the same core functions the front desk uses, so the same rules
 * apply: date checks, capacity, per-night availability under row locks
 * (no double booking), guest de-duplication. In addition, a free room of the
 * requested type is assigned automatically when one exists, which makes that
 * room RESERVED.
 *
 * The booking is identified by the booking system's own id
 * (external_reservation_id, unique per system); the PMS reservation_id is
 * returned so the other systems can refer to it.
 */
import { UniqueConstraintError } from "sequelize";
import { Reservation, RoomType, Room, RESERVATION_SOURCE } from "../../models/index.js";
import { conflict, notFound, validationError } from "../../utils/errors.js";
import { withTransaction } from "../../services/tx.js";
import { createReservation, updateReservation, cancelReservation } from "../../services/reservationService.js";
import { availabilityByType, assertValidDates } from "../../services/availabilityService.js";
import { listRoomTypes } from "../../services/roomService.js";

const SOURCE = RESERVATION_SOURCE.RESERVATION_SYSTEM;

const roomTypeIdByName = async (name, transaction) => (await RoomType.findOne({ where: { name }, attributes: ["id"], transaction }))?.id ?? null;

/** room_type_id (preferred) or room_type name → the type name used by the PMS. */
async function resolveRoomType({ room_type_id: id, room_type: name }, { required }) {
  if (id !== undefined) {
    const type = await RoomType.findByPk(id);
    const hasRooms = type && (await Room.count({ where: { roomType: type.name, isActive: true } })) > 0;
    if (!hasRooms) throw validationError({ room_type_id: `Unknown room type id ${id}. See GET /room-types.` });
    return type.name;
  }
  if (name !== undefined) return name;
  if (required) throw validationError({ room_type_id: "Send room_type_id (see GET /room-types)." });
  return undefined;
}

/** Response shape for the Booking System (references and statuses, no guest contact data). */
export async function bookingView(r, transaction) {
  const room = r.room || (r.roomId ? await Room.findByPk(r.roomId, { transaction }) : null);
  return {
    reservation_id: r.id,
    reservation_code: r.reservationCode,
    external_reservation_id: r.externalReservationId,
    booking_reference: r.bookingReference ?? null,
    status: r.status,
    guest_id: r.guestId,
    room_type_id: await roomTypeIdByName(r.roomType, transaction),
    room_type: r.roomType,
    room_assignment: room ? "ASSIGNED" : "PENDING",
    room: room
      ? { room_id: room.id, room_number: room.roomNumber, floor: room.floor, room_type: room.roomType, status: room.status }
      : null,
    check_in_date: r.checkInDate,
    check_out_date: r.checkOutDate,
    number_of_guests: r.numGuests,
    payment_status: r.externalPaymentStatus ?? null,
    cancelled_at: r.cancelledAt ?? null,
    last_synced_at: r.lastSyncedAt ?? null,
  };
}

const findExternal = async (externalReservationId, transaction) => {
  const r = await Reservation.findOne({ where: { source: SOURCE, externalReservationId }, include: ["room"], transaction });
  if (!r) throw notFound("Reservation");
  return r;
};

const guestInput = (g) =>
  g && {
    ...(g.first_name !== undefined ? { firstName: g.first_name } : {}),
    ...(g.last_name !== undefined ? { lastName: g.last_name } : {}),
    ...(g.email !== undefined ? { email: g.email } : {}),
    ...(g.phone !== undefined ? { phone: g.phone } : {}),
  };

const duplicate = async (externalReservationId) => {
  const existing = await Reservation.findOne({ where: { source: SOURCE, externalReservationId }, include: ["room"] });
  return conflict(
    "DUPLICATE_RESERVATION",
    "A reservation with this external_reservation_id already exists.",
    existing ? await bookingView(existing) : undefined
  );
};

/*
 * Lookups by external id happen OUTSIDE the write transaction on purpose:
 * under MySQL REPEATABLE READ the first plain read of a transaction fixes its
 * snapshot, and it must come after the availability lock (see
 * availabilityService.peekRoomType), or a booking committed meanwhile by
 * another request would be invisible to the overbooking check.
 */
export async function createFromBooking(input) {
  const roomType = await resolveRoomType(input, { required: true });
  if (await Reservation.count({ where: { source: SOURCE, externalReservationId: input.external_reservation_id } })) {
    throw await duplicate(input.external_reservation_id);
  }
  try {
    return await withTransaction(null, async (t) => {
      const reservation = await createReservation(
        {
          guest: guestInput(input.guest),
          roomType,
          checkInDate: input.check_in_date,
          checkOutDate: input.check_out_date,
          numGuests: input.number_of_guests,
          externalReservationId: input.external_reservation_id,
          bookingReference: input.booking_reference,
          externalPaymentStatus: input.payment_status,
          notes: input.notes,
        },
        { source: SOURCE, transaction: t, autoAssignRoom: true }
      );
      return bookingView(reservation, t);
    });
  } catch (err) {
    // Two simultaneous requests for the same booking: the unique index decides.
    if (err instanceof UniqueConstraintError) throw await duplicate(input.external_reservation_id);
    throw err;
  }
}

export const getBooking = async (externalReservationId) => bookingView(await findExternal(externalReservationId));

export async function updateFromBooking(externalReservationId, input) {
  const roomType = await resolveRoomType(input, { required: false });
  const { id } = await findExternal(externalReservationId);
  return withTransaction(null, async (t) => {
    const changes = {};
    if (roomType !== undefined) changes.roomType = roomType;
    if (input.check_in_date !== undefined) changes.checkInDate = input.check_in_date;
    if (input.check_out_date !== undefined) changes.checkOutDate = input.check_out_date;
    if (input.number_of_guests !== undefined) changes.numGuests = input.number_of_guests;
    if (input.booking_reference !== undefined) changes.bookingReference = input.booking_reference;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.payment_status !== undefined) changes.externalPaymentStatus = input.payment_status;
    const reservation = await updateReservation({ id }, changes, { transaction: t, syncedFromExternal: true, autoAssignRoom: true });
    if (input.guest) {
      const guest = await reservation.getGuest({ transaction: t });
      await guest.update(guestInput(input.guest), { transaction: t });
    }
    return bookingView(await findExternal(externalReservationId, t), t);
  });
}

export async function cancelFromBooking(externalReservationId, reason) {
  const { id } = await findExternal(externalReservationId);
  return withTransaction(null, async (t) => {
    await cancelReservation({ id }, reason, { transaction: t, syncedFromExternal: true });
    return bookingView(await findExternal(externalReservationId, t), t);
  });
}

export async function availability({ check_in_date: checkInDate, check_out_date: checkOutDate, room_type_id }) {
  assertValidDates({ checkInDate, checkOutDate });
  const roomType = room_type_id !== undefined ? await resolveRoomType({ room_type_id }, { required: false }) : undefined;
  const types = await availabilityByType({ checkInDate, checkOutDate, roomType });
  const ids = await RoomType.findAll({ attributes: ["id", "name"] });
  const idOf = (name) => ids.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  return {
    check_in_date: checkInDate,
    check_out_date: checkOutDate,
    room_types: types.map((x) => ({
      room_type_id: idOf(x.roomType),
      room_type: x.roomType,
      available_rooms: x.availableRooms,
      total_rooms: x.totalRooms,
      max_capacity: x.maxCapacity,
      min_nightly_rate: x.minRate,
    })),
  };
}

export const roomTypes = async () =>
  (await listRoomTypes()).map((t) => ({
    room_type_id: t.roomTypeId,
    room_type: t.roomType,
    room_count: t.roomCount,
    max_capacity: t.maxCapacity,
    min_nightly_rate: t.minRate,
    max_nightly_rate: t.maxRate,
  }));
