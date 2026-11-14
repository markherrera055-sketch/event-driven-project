/**
 * Reservation module — display reservation (1.0 in the DFD), plus the
 * minimum needed to run without the external Hotel Reservation System:
 * create, modify, assign a room, cancel. All writes run in a transaction
 * with the availability lock (see availabilityService).
 */
import crypto from "crypto";
import { Op } from "sequelize";
import {
  Reservation,
  Guest,
  Room,
  Stay,
  RESERVATION_STATUS,
  RESERVATION_SOURCE,
  ROOM_STATUS,
  STAY_STATUS,
} from "../models/index.js";
import { conflict, notFound, validationError } from "../utils/errors.js";
import { today, addDays } from "../utils/dates.js";
import { pageMeta } from "../utils/http.js";
import { assertBookable, assertValidDates, findAvailableRooms, lockRoomTypes, peekRoomType } from "./availabilityService.js";
import { findOrCreateGuest } from "./guestService.js";
import { reservationJSON, roomJSON } from "./serializers.js";
import { setVacant } from "./roomService.js";
import { withTransaction } from "./tx.js";
import { emit, EVENTS } from "./domainEvents.js";
import { logger } from "../utils/logger.js";

const detailInclude = [
  "guest",
  "room",
  { association: "verifications", include: [{ association: "verifier", attributes: ["id", "fullName", "role"] }] },
  { association: "stay", include: ["bill"] },
];

export const eventPayload = (reservation, room, origin = "PMS") => ({
  origin,
  reservationCode: reservation.reservationCode,
  source: reservation.source,
  externalReservationId: reservation.externalReservationId,
  bookingReference: reservation.bookingReference,
  status: reservation.status,
  roomType: reservation.roomType,
  roomNumber: room ? room.roomNumber : null,
  checkInDate: reservation.checkInDate,
  checkOutDate: reservation.checkOutDate,
  numGuests: reservation.numGuests,
  occurredAt: new Date().toISOString(),
});

/** List with search + quick views used by the front desk. */
export async function listReservations({ search, status, view, date, page, limit, offset }) {
  const where = {};
  const d = date || today();
  if (status) where.status = status;
  if (view === "arrivals") Object.assign(where, { status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.lte]: d } });
  if (view === "departures") Object.assign(where, { status: RESERVATION_STATUS.CHECKED_IN, checkOutDate: { [Op.lte]: d } });
  if (view === "upcoming") Object.assign(where, { status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.gte]: d } });
  if (view === "in-house") where.status = RESERVATION_STATUS.CHECKED_IN;

  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [
      { reservationCode: like },
      { externalReservationId: like },
      { bookingReference: like },
      { "$guest.first_name$": like },
      { "$guest.last_name$": like },
      { "$room.room_number$": like },
    ];
  }

  const { rows, count } = await Reservation.findAndCountAll({
    where,
    include: [
      { model: Guest, as: "guest", required: true },
      { model: Room, as: "room", required: false },
    ],
    order: [["checkInDate", view === "upcoming" || view === "arrivals" ? "ASC" : "DESC"], ["id", "DESC"]],
    limit,
    offset,
    distinct: true,
    subQuery: false,
  });
  return { data: rows.map(reservationJSON), meta: pageMeta({ page, limit }, count) };
}

const findReservation = async (where) => {
  const reservation = await Reservation.findOne({ where, include: detailInclude });
  if (!reservation) throw notFound("Reservation");
  return reservationJSON(reservation);
};

export const getReservation = (id) => findReservation({ id });
export const getReservationByCode = (code) => findReservation({ reservationCode: String(code).toUpperCase() });

/**
 * Creates a reservation (status CONFIRMED). Used by the front desk and by the
 * Reservation System integration (source + external identifiers).
 */
export async function createReservation(input, { actor, source = RESERVATION_SOURCE.FRONT_DESK, transaction } = {}) {
  assertValidDates(input);
  return withTransaction(transaction, async (t) => {
    const { roomType, room } = await assertBookable(
      { roomType: input.roomType, roomId: input.roomId, checkInDate: input.checkInDate, checkOutDate: input.checkOutDate, numGuests: input.numGuests },
      t
    );

    let guest;
    if (input.guestId) {
      guest = await Guest.findByPk(input.guestId, { transaction: t });
      if (!guest) throw validationError({ guestId: "Guest not found." });
    } else {
      guest = await findOrCreateGuest(input.guest, t);
    }

    const reservation = await Reservation.create(
      {
        reservationCode: `TMP-${crypto.randomUUID()}`.slice(0, 20),
        guestId: guest.id,
        roomId: room ? room.id : null,
        roomType,
        checkInDate: input.checkInDate,
        checkOutDate: input.checkOutDate,
        numGuests: input.numGuests,
        status: RESERVATION_STATUS.CONFIRMED,
        source,
        externalReservationId: input.externalReservationId || null,
        bookingReference: input.bookingReference || null,
        externalPaymentStatus: input.externalPaymentStatus || null,
        notes: input.notes || null,
        createdBy: actor?.id || null,
        lastSyncedAt: source === RESERVATION_SOURCE.RESERVATION_SYSTEM ? new Date() : null,
      },
      { transaction: t }
    );
    await reservation.update({ reservationCode: `RSV-${String(reservation.id).padStart(4, "0")}` }, { transaction: t });
    await emit(EVENTS.RESERVATION_CREATED, eventPayload(reservation, room), { transaction: t });
    logger.info("reservation_created", { reservationId: reservation.id, code: reservation.reservationCode, source, by: actor?.id });
    return reservation;
  }).then((r) => (transaction ? r : getReservation(r.id)));
}

const lockReservation = async (where, t) => {
  const reservation = await Reservation.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
  if (!reservation) throw notFound("Reservation");
  return reservation;
};

const assertModifiable = (reservation) => {
  if (reservation.status !== RESERVATION_STATUS.CONFIRMED) {
    throw conflict(
      "RESERVATION_NOT_MODIFIABLE",
      `Reservation ${reservation.reservationCode} is ${reservation.status} and can no longer be changed.`
    );
  }
};

/**
 * Modifies dates / room type / guest count / room of a CONFIRMED reservation.
 * Availability is re-checked against the new values. If the room type changes
 * and the assigned room no longer matches, the room assignment is cleared.
 */
export async function updateReservation(where, changes, { actor, transaction, syncedFromExternal = false } = {}) {
  return withTransaction(transaction, async (t) => {
    const reservation = await lockReservation(where, t);
    assertModifiable(reservation);

    const next = {
      checkInDate: changes.checkInDate ?? reservation.checkInDate,
      checkOutDate: changes.checkOutDate ?? reservation.checkOutDate,
      numGuests: changes.numGuests ?? reservation.numGuests,
      roomType: changes.roomType ?? reservation.roomType,
      roomId: changes.roomId !== undefined ? changes.roomId : reservation.roomId,
    };
    if (changes.roomType && changes.roomType !== reservation.roomType && changes.roomId === undefined) {
      next.roomId = null;
    }
    const datesChanged = changes.checkInDate || changes.checkOutDate;
    if (datesChanged) assertValidDates(next, { allowPastCheckIn: next.checkInDate === reservation.checkInDate });

    const newAssignment = !!next.roomId && next.roomId !== reservation.roomId;
    const { roomType, room } = await assertBookable({ ...next, excludeReservationId: reservation.id, newAssignment }, t);

    const update = { ...next, roomType, roomId: room ? room.id : null };
    for (const key of ["notes", "externalPaymentStatus", "bookingReference"]) {
      if (changes[key] !== undefined) update[key] = changes[key];
    }
    if (syncedFromExternal) update.lastSyncedAt = new Date();
    await reservation.update(update, { transaction: t });
    await emit(EVENTS.RESERVATION_UPDATED, eventPayload(reservation, room, syncedFromExternal ? "RESERVATION_SYSTEM" : "PMS"), { transaction: t });
    logger.info("reservation_updated", { reservationId: reservation.id, fields: Object.keys(changes), by: actor?.id });
    return reservation;
  }).then((r) => (transaction ? r : getReservation(r.id)));
}

/**
 * Assigns or changes the room of a reservation (the editable "Assigned room").
 *  - CONFIRMED: the reservation simply points at the new room. The previous
 *    room is released automatically, because a room's availability is derived
 *    from the reservations that hold it. Guest, dates and booking details are
 *    untouched; the room type follows the new room.
 *  - CHECKED_IN: an in-house room move (see moveInHouseGuest).
 * Every check is repeated inside the transaction under row locks, so two
 * clerks cannot give the same room away twice.
 */
export async function assignRoom(id, roomId, { actor } = {}) {
  const current = await Reservation.findByPk(id, { attributes: ["id", "status", "roomId"] });
  if (!current) throw notFound("Reservation");
  if (current.roomId === roomId) throw validationError({ roomId: "This room is already assigned to the reservation." });
  if (current.status === RESERVATION_STATUS.CHECKED_IN) return moveInHouseGuest(id, roomId, { actor });
  // updateReservation re-locks the row and re-checks the status (still CONFIRMED).
  return updateReservation({ id }, { roomId }, { actor });
}

/**
 * Room move for a checked-in guest, in one transaction:
 *   new room VACANT → OCCUPIED, previous room OCCUPIED → VACANT (needs
 *   cleaning, since the guest used it), reservation → new room.
 * The new room must be in service, not under maintenance, vacant, clean, big
 * enough and free for the rest of the stay. Moves are refused once a final
 * bill exists, because the bill is priced from the room at generation time.
 */
export async function moveInHouseGuest(id, roomId, { actor } = {}) {
  const target = await peekRoomType(roomId);
  if (!target || !target.isActive) throw notFound("Room");
  await withTransaction(null, async (t) => {
    const reservation = await lockReservation({ id }, t);
    if (reservation.status !== RESERVATION_STATUS.CHECKED_IN) {
      throw conflict("RESERVATION_NOT_IN_HOUSE", `Reservation ${reservation.reservationCode} is ${reservation.status}.`);
    }
    if (reservation.roomId === roomId) throw validationError({ roomId: "This room is already assigned to the reservation." });

    const stay = await Stay.findOne({
      where: { reservationId: reservation.id, status: STAY_STATUS.IN_HOUSE },
      include: ["bill"],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Stay },
    });
    if (!stay) throw conflict("RESERVATION_NOT_IN_HOUSE", "This guest has no in-house stay.");
    if (stay.bill) {
      throw conflict("BILL_ALREADY_GENERATED", "A final bill has already been generated for this stay, so the room can no longer be changed.");
    }

    // Both the old and the new room type are locked, in the global order.
    await lockRoomTypes([reservation.roomType, target.roomType], t);
    const d = today();
    const { room } = await assertBookable(
      {
        roomId,
        checkInDate: reservation.checkInDate,
        // An overstaying guest still needs tonight.
        checkOutDate: reservation.checkOutDate > d ? reservation.checkOutDate : addDays(d, 1),
        numGuests: reservation.numGuests,
        excludeReservationId: reservation.id,
        fromDate: d,
      },
      t
    );
    if (room.status !== ROOM_STATUS.VACANT) throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is not vacant.`);
    if (room.needsCleaning) {
      throw conflict("ROOM_NOT_READY", `Room ${room.roomNumber} has not been cleaned since the last guest. Mark it clean first.`);
    }

    const previousRoomId = reservation.roomId;
    const [moved] = await Room.update(
      { status: ROOM_STATUS.OCCUPIED },
      { where: { id: room.id, status: ROOM_STATUS.VACANT, needsCleaning: false }, transaction: t }
    );
    if (moved !== 1) throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} was just taken. Choose another room.`);
    if (previousRoomId) await setVacant(previousRoomId, t);
    await reservation.update({ roomId: room.id, roomType: room.roomType }, { transaction: t });

    await emit(EVENTS.RESERVATION_UPDATED, eventPayload(reservation, room), { transaction: t });
    logger.info("room_moved", { reservationId: reservation.id, stayId: stay.id, fromRoomId: previousRoomId, toRoomId: room.id, by: actor?.id });
  });
  return getReservation(id);
}

export async function cancelReservation(where, reason, { actor, transaction, syncedFromExternal = false } = {}) {
  return withTransaction(transaction, async (t) => {
    const reservation = await lockReservation(where, t);
    assertModifiable(reservation);
    await reservation.update(
      {
        status: RESERVATION_STATUS.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: reason || null,
        ...(syncedFromExternal ? { lastSyncedAt: new Date() } : {}),
      },
      { transaction: t }
    );
    await emit(EVENTS.RESERVATION_CANCELLED, eventPayload(reservation, null, syncedFromExternal ? "RESERVATION_SYSTEM" : "PMS"), { transaction: t });
    logger.info("reservation_cancelled", { reservationId: reservation.id, by: actor?.id });
    return reservation;
  }).then((r) => (transaction ? r : getReservation(r.id)));
}

/**
 * Rooms eligible for this reservation's dates (same type by default). For an
 * in-house guest only rooms that are vacant and clean right now are offered.
 */
export async function assignableRooms(id, { allTypes = false } = {}) {
  const reservation = await Reservation.findByPk(id);
  if (!reservation) throw notFound("Reservation");
  const inHouse = reservation.status === RESERVATION_STATUS.CHECKED_IN;
  if (!inHouse && reservation.status !== RESERVATION_STATUS.CONFIRMED) {
    throw conflict("RESERVATION_NOT_MODIFIABLE", `Reservation ${reservation.reservationCode} is ${reservation.status}; its room can no longer be changed.`);
  }
  const d = today();
  const rooms = await findAvailableRooms({
    checkInDate: reservation.checkInDate,
    checkOutDate: inHouse && reservation.checkOutDate <= d ? addDays(d, 1) : reservation.checkOutDate,
    numGuests: reservation.numGuests,
    roomType: allTypes ? undefined : reservation.roomType,
    excludeReservationId: reservation.id,
    forRoomMove: inHouse,
  });
  return rooms.filter((room) => room.id !== reservation.roomId).map(roomJSON);
}
