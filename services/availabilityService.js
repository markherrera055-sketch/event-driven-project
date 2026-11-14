/**
 * Availability and overbooking protection, shared by front-desk reservations,
 * room assignment / room moves, room administration and reservations received
 * from the external Hotel Reservation System.
 *
 * Rules:
 *  - A specific room cannot hold two active (CONFIRMED / CHECKED_IN)
 *    reservations whose date ranges overlap. Availability is always computed
 *    from reservation DATES, never from today's room status alone: a room that
 *    is vacant today may already be booked for tomorrow.
 *  - A room that is physically occupied by an in-house guest (even one who is
 *    past their check-out date) cannot be given to a stay that includes today.
 *  - A room under MAINTENANCE cannot be newly assigned.
 *  - For each night, the number of active reservations of a room type cannot
 *    exceed the number of sellable rooms of that type (covers bookings that are
 *    not yet assigned to a room). Maintenance has no planned end date, so a
 *    room under maintenance is unsellable for tonight but still counts for
 *    future nights.
 * All rooms of the type are locked (SELECT ... FOR UPDATE) for the duration of
 * the caller's transaction, so concurrent bookings / assignments are serialised
 * and every check is re-done against committed data right before saving.
 */
import { Op } from "sequelize";
import { Room, Reservation, ACTIVE_RESERVATION_STATUSES, RESERVATION_STATUS, ROOM_STATUS } from "../models/index.js";
import { conflict, validationError, notFound } from "../utils/errors.js";
import { eachNight, nightsBetween, today } from "../utils/dates.js";

export const MAX_STAY_NIGHTS = 60;

export function assertValidDates({ checkInDate, checkOutDate }, { allowPastCheckIn = false } = {}) {
  if (checkOutDate <= checkInDate) {
    throw validationError({ checkOutDate: "Check-out date must be after the check-in date." });
  }
  if (!allowPastCheckIn && checkInDate < today()) {
    throw validationError({ checkInDate: "Check-in date cannot be in the past." });
  }
  if (nightsBetween(checkInDate, checkOutDate) > MAX_STAY_NIGHTS) {
    throw validationError({ checkOutDate: `A reservation cannot exceed ${MAX_STAY_NIGHTS} nights.` });
  }
}

/**
 * Active reservations overlapping [checkInDate, checkOutDate). A checked-in
 * guest still occupies their room tonight even after their booked check-out
 * date (overdue departure), so when the range includes tonight every
 * checked-in reservation counts.
 */
const overlapWhere = ({ checkInDate, checkOutDate, excludeReservationId }) => {
  const d = today();
  const byDates = { checkInDate: { [Op.lt]: checkOutDate }, checkOutDate: { [Op.gt]: checkInDate } };
  const where = {
    status: { [Op.in]: ACTIVE_RESERVATION_STATUSES },
    [Op.or]: checkInDate <= d && d < checkOutDate ? [byDates, { status: RESERVATION_STATUS.CHECKED_IN, checkInDate: { [Op.lte]: d } }] : [byDates],
  };
  if (excludeReservationId) where.id = { [Op.ne]: excludeReservationId };
  return where;
};

/** Sellable rooms for a night: rooms under maintenance are unsellable tonight; future nights still count them. */
const capacityFor = (rooms, night, d = today()) =>
  night <= d ? rooms.filter((r) => r.status !== ROOM_STATUS.MAINTENANCE).length : rooms.length;

/** Reservations holding a room on `night` (an overdue in-house guest still holds one tonight). */
const loadOn = (reservations, night, d = today()) =>
  reservations.filter(
    (r) => r.checkInDate <= night && (r.checkOutDate > night || (night === d && r.status === RESERVATION_STATUS.CHECKED_IN))
  ).length;

/** First night in [from, to) on which one more reservation would exceed the sellable rooms, or null. */
const firstFullNight = (reservations, rooms, from, to) => {
  const d = today();
  for (const night of eachNight(from, to)) {
    if (loadOn(reservations, night, d) >= capacityFor(rooms, night, d)) return night;
  }
  return null;
};

const sameTypeReservations = (roomType, range, transaction) =>
  Reservation.findAll({
    where: { ...overlapWhere(range), roomType },
    attributes: ["id", "status", "checkInDate", "checkOutDate"],
    transaction,
  });

/** In-house guest physically in `roomId` other than `excludeReservationId` (null when none). */
const inHouseOccupant = (roomId, excludeReservationId, transaction) =>
  Reservation.findOne({
    where: {
      roomId,
      status: RESERVATION_STATUS.CHECKED_IN,
      ...(excludeReservationId ? { id: { [Op.ne]: excludeReservationId } } : {}),
    },
    attributes: ["id", "reservationCode"],
    transaction,
  });

/**
 * Locks every room of the given types (SELECT ... FOR UPDATE), always in the
 * same order — type name, then id — so concurrent bookings, room moves and
 * room edits queue up instead of deadlocking.
 */
export async function lockRoomTypes(roomTypes, transaction) {
  const locked = [];
  for (const roomType of [...new Set(roomTypes)].sort()) {
    locked.push(...(await Room.findAll({ where: { roomType }, order: [["id", "ASC"]], lock: transaction.LOCK.UPDATE, transaction })));
  }
  return locked;
}

/**
 * Room type of a room, read OUTSIDE the caller's transaction. Under MySQL's
 * REPEATABLE READ, the first plain read inside a transaction freezes its
 * snapshot; doing it before the room-type lock is granted would hide a
 * booking another clerk commits while we wait (double booking). Learning the
 * type here keeps the transaction's first plain read after the lock.
 */
export const peekRoomType = async (roomId) => (await Room.findByPk(roomId, { attributes: ["id", "roomType", "isActive"] })) || null;

/**
 * Throws if the booking cannot be accepted. Must be called inside a transaction.
 * Returns { roomType, room } (room is null when booking by type only).
 *
 *  - newAssignment: the room is being newly assigned (not merely kept while
 *    dates change), so maintenance / physical occupancy are checked too.
 *  - fromDate: only check nights from this date (room moves of in-house guests
 *    re-check the remaining nights, not nights already spent).
 */
export async function assertBookable(
  { roomType, roomId, checkInDate, checkOutDate, numGuests, excludeReservationId, newAssignment = true, fromDate },
  transaction
) {
  let room = null;
  if (roomId) {
    const found = await peekRoomType(roomId);
    if (!found || !found.isActive) throw notFound("Room");
    roomType = found.roomType;
  }

  const rooms = (await lockRoomTypes([roomType], transaction)).filter((r) => r.isActive);
  if (rooms.length === 0) {
    throw validationError({ roomType: `Unknown or unavailable room type "${roomType}".` });
  }
  if (roomId) {
    // Use the locked row, so the checks below see committed, current data.
    room = rooms.find((r) => r.id === Number(roomId));
    if (!room) throw conflict("ROOM_CHANGED", "The room was changed by someone else. Reload and try again.");
  }

  const maxCapacity = Math.max(...rooms.map((r) => r.capacity));
  if (room && numGuests > room.capacity) {
    throw validationError({ numGuests: `Room ${room.roomNumber} holds at most ${room.capacity} guests.` });
  }
  if (numGuests > maxCapacity) {
    throw validationError({ numGuests: `${roomType} rooms hold at most ${maxCapacity} guests.` });
  }

  if (room) {
    if (newAssignment && room.status === ROOM_STATUS.MAINTENANCE) {
      throw conflict("ROOM_UNDER_MAINTENANCE", `Room ${room.roomNumber} is under maintenance and cannot be assigned.`);
    }
    if (newAssignment && room.status === ROOM_STATUS.OCCUPIED && checkInDate <= today()) {
      const occupant = await inHouseOccupant(room.id, excludeReservationId, transaction);
      if (occupant) {
        throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is still occupied by an in-house guest (${occupant.reservationCode}).`);
      }
    }
    const clash = await Reservation.findOne({
      where: { ...overlapWhere({ checkInDate, checkOutDate, excludeReservationId }), roomId: room.id },
      transaction,
    });
    if (clash) {
      throw conflict("ROOM_UNAVAILABLE", `Room ${room.roomNumber} is already booked for part of these dates (${clash.reservationCode}).`);
    }
  }

  const from = fromDate && fromDate > checkInDate ? fromDate : checkInDate;
  if (from < checkOutDate) {
    const sameType = await sameTypeReservations(roomType, { checkInDate: from, checkOutDate, excludeReservationId }, transaction);
    const full = firstFullNight(sameType, rooms, from, checkOutDate);
    if (full) {
      throw conflict("NO_AVAILABILITY", `No ${roomType} rooms are available for ${checkInDate} to ${checkOutDate} (fully booked on ${full}).`);
    }
  }

  return { roomType, room };
}

/**
 * Rooms that can be assigned to a stay in the given range — the same rules as
 * assertBookable, applied to every candidate room (used to fill the room
 * picker; the chosen room is re-checked under lock when saving).
 *  - forRoomMove: the guest is already in-house and moves now, so the room
 *    must also be vacant and clean right now.
 */
export async function findAvailableRooms({ checkInDate, checkOutDate, numGuests = 1, roomType, excludeReservationId, forRoomMove = false }) {
  const d = today();
  const where = { isActive: true, capacity: { [Op.gte]: numGuests }, status: { [Op.ne]: ROOM_STATUS.MAINTENANCE } };
  if (roomType) where.roomType = roomType;
  if (forRoomMove) Object.assign(where, { status: ROOM_STATUS.VACANT, needsCleaning: false });
  const candidates = await Room.findAll({ where, order: [["roomNumber", "ASC"]] });
  if (!candidates.length) return [];

  const range = { checkInDate, checkOutDate, excludeReservationId };
  const busy = await Reservation.findAll({
    where: { ...overlapWhere(range), roomId: { [Op.in]: candidates.map((r) => r.id) } },
    attributes: ["roomId"],
  });
  const busyIds = new Set(busy.map((r) => r.roomId));
  if (checkInDate <= d) {
    // Overstaying in-house guests occupy their room beyond their booked dates.
    const occupied = await Reservation.findAll({
      where: {
        status: RESERVATION_STATUS.CHECKED_IN,
        roomId: { [Op.in]: candidates.map((r) => r.id) },
        ...(excludeReservationId ? { id: { [Op.ne]: excludeReservationId } } : {}),
      },
      attributes: ["roomId"],
    });
    occupied.forEach((r) => busyIds.add(r.roomId));
  }

  // Type-level capacity: a free room of a type that is already fully sold
  // (by bookings not yet assigned to a room) cannot be taken.
  const from = forRoomMove && d > checkInDate ? d : checkInDate;
  const typesWithRoom = new Set();
  for (const type of new Set(candidates.map((r) => r.roomType))) {
    const rooms = await Room.findAll({ where: { roomType: type, isActive: true }, attributes: ["id", "status"] });
    const sameType = await sameTypeReservations(type, { checkInDate: from, checkOutDate, excludeReservationId });
    if (!firstFullNight(sameType, rooms, from, checkOutDate)) typesWithRoom.add(type);
  }

  return candidates.filter((r) => !busyIds.has(r.id) && typesWithRoom.has(r.roomType));
}

/**
 * Refuses taking `room` out of the sellable inventory (deactivate / delete /
 * maintenance / type change) when the remaining rooms of its type could no
 * longer honour the active reservations of that type, including reservations
 * not yet assigned to a room. Must run inside a transaction.
 *  - tonightOnly: maintenance only removes the room for tonight.
 */
export async function assertRoomRemovable(room, { tonightOnly = false } = {}, transaction) {
  const d = today();
  const rooms = (await lockRoomTypes([room.roomType], transaction)).filter((r) => r.isActive);
  const remaining = rooms.filter((r) => r.id !== room.id);
  const reservations = await Reservation.findAll({
    where: {
      roomType: room.roomType,
      [Op.or]: [
        { status: { [Op.in]: ACTIVE_RESERVATION_STATUSES }, checkOutDate: { [Op.gt]: d } },
        { status: RESERVATION_STATUS.CHECKED_IN }, // overdue departures still hold a room tonight
      ],
    },
    attributes: ["id", "status", "checkInDate", "checkOutDate"],
    transaction,
  });
  // Load only rises on check-in dates, so checking tonight and each future check-in date finds the peak.
  const nights = tonightOnly ? [d] : [...new Set([d, ...reservations.map((r) => r.checkInDate).filter((n) => n > d)])].sort();
  for (const night of nights) {
    const load = loadOn(reservations, night, d);
    const capacity = capacityFor(remaining, night, d);
    if (load > capacity) {
      throw conflict(
        "ROOM_NEEDED_FOR_BOOKINGS",
        `Room ${room.roomNumber} is needed: ${load} ${room.roomType} reservation(s) are booked for ${night} and only ${capacity} other ${room.roomType} room(s) would be available.`
      );
    }
  }
}

/** Per-room-type availability for a date range (exposed to the Hotel Reservation System). */
export async function availabilityByType({ checkInDate, checkOutDate, roomType }) {
  const where = { isActive: true };
  if (roomType) where.roomType = roomType;
  const rooms = await Room.findAll({ where, attributes: ["roomType", "capacity", "nightlyRate", "status"] });
  const byType = new Map();
  for (const r of rooms) {
    const t = byType.get(r.roomType) || { roomType: r.roomType, totalRooms: 0, maxCapacity: 0, minRate: Infinity, rooms: [] };
    t.totalRooms += 1;
    t.maxCapacity = Math.max(t.maxCapacity, r.capacity);
    t.minRate = Math.min(t.minRate, Number(r.nightlyRate));
    t.rooms.push(r);
    byType.set(r.roomType, t);
  }
  const reservations = await Reservation.findAll({
    where: { ...overlapWhere({ checkInDate, checkOutDate }), roomType: { [Op.in]: [...byType.keys()] } },
    attributes: ["roomType", "status", "checkInDate", "checkOutDate"],
  });
  const d = today();
  return [...byType.values()]
    .sort((a, b) => a.roomType.localeCompare(b.roomType))
    .map(({ rooms: typeRooms, ...t }) => {
      const own = reservations.filter((r) => r.roomType === t.roomType);
      let free = t.totalRooms;
      for (const night of eachNight(checkInDate, checkOutDate)) {
        free = Math.min(free, capacityFor(typeRooms, night, d) - loadOn(own, night, d));
      }
      return { ...t, availableRooms: Math.max(0, free) };
    });
}
