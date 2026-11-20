/**
 * StayBook (online booking, Member 1) → PMS, room-based contract.
 *
 * StayBook sells SPECIFIC rooms (its own rooms.id), quotes a price and keeps
 * its own booking status. This adapter translates that into a normal PMS
 * reservation through the same core functions the front desk uses, so every
 * PMS rule still applies: date checks, capacity, per-night availability under
 * row locks (no double booking), guest de-duplication, room status.
 *
 *   StayBook room id ──external_room_mappings──► PMS room   (explicit, admin-maintained)
 *   StayBook booking ──external_bookings──────► PMS reservation (1 — 1)
 *
 * Identity in the PMS: reservations.source = RESERVATION_SYSTEM and
 * reservations.external_reservation_id = StayBook booking reference, so the
 * existing Booking webhooks (ReservationUpdated / Cancelled, GuestCheckedIn /
 * Out) reach StayBook for changes made at the front desk.
 *
 * Money: StayBook's price is stored as a QUOTE only. StayBook payments are
 * simulated, so no payment is ever recorded here; the guest settles the
 * PMS bill at the front desk.
 *
 * Privacy: responses and logs carry ids, references and statuses only —
 * never guest contact details.
 */
import { Op, UniqueConstraintError } from "sequelize";
import {
  Reservation,
  Room,
  ExternalBooking,
  ExternalRoomMapping,
  EXTERNAL_SYSTEMS,
  EXTERNAL_SYNC_STATUS,
  RESERVATION_SOURCE,
  RESERVATION_STATUS,
  ROOM_STATUS,
} from "../../models/index.js";
import { AppError, conflict, validationError } from "../../utils/errors.js";
import { withTransaction } from "../../services/tx.js";
import { createReservation, updateReservation, cancelReservation } from "../../services/reservationService.js";
import { assertValidDates, findAvailableRooms } from "../../services/availabilityService.js";
import { nightsBetween } from "../../utils/dates.js";
import { multiplyMoney, sameAmount } from "../../utils/money.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const SYSTEM = EXTERNAL_SYSTEMS.STAYBOOK;
const SOURCE = RESERVATION_SOURCE.RESERVATION_SYSTEM;

/** StayBook booking statuses (OnlineBooking API documentation §5). */
export const STAYBOOK_STATUS = Object.freeze({
  LOCAL_CONFIRMED: "LOCAL_CONFIRMED", // saved in StayBook, awaiting StayBook staff confirmation
  ADMIN_CONFIRMED: "ADMIN_CONFIRMED", // confirmed by StayBook staff
  CANCELLED: "CANCELLED",
});
/** Statuses that hold a room — both become a CONFIRMED PMS reservation. */
export const ACTIVE_STAYBOOK_STATUSES = [STAYBOOK_STATUS.LOCAL_CONFIRMED, STAYBOOK_STATUS.ADMIN_CONFIRMED];
/** StayBook only simulates payments; anything else needs a new agreement first. */
export const PAYMENT_MODES = ["SIMULATED"];

// ── helpers ──────────────────────────────────────────────────────────────────

/** External ids are stored as text; numeric ones are returned as numbers (StayBook uses integer ids). */
const toId = (value) => (value === null || value === undefined ? null : /^\d{1,15}$/.test(String(value)) ? Number(value) : String(value));
const amount = (value) => (value === null || value === undefined ? null : Number(value));

/** Core validation errors use PMS field names; report them with the contract's names. */
const FIELD_NAMES = {
  checkInDate: "check_in",
  checkOutDate: "check_out",
  numGuests: "guests",
  roomId: "frontdesk_room_id",
  roomType: "staybook_room_id",
  firstName: "guest.first_name",
  lastName: "guest.last_name",
  email: "guest.email",
  phone: "guest.phone",
};
const translate = (err) => {
  if (err instanceof AppError && err.code === "VALIDATION_ERROR" && err.details && typeof err.details === "object") {
    err.details = Object.fromEntries(Object.entries(err.details).map(([k, v]) => [FIELD_NAMES[k] || k, v]));
  }
  return err;
};
const translated = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw translate(err);
  }
};

function assertHotel(hotelId) {
  const expected = config.integrations.staybook.hotelId;
  if (expected && String(hotelId) !== String(expected)) {
    throw new AppError(422, "HOTEL_NOT_MANAGED", `StayBook hotel ${hotelId} is not managed by this Frontdesk.`, { hotel_id: "Unknown hotel for this Frontdesk." });
  }
}

/** nights must agree with the dates; the currency must be the hotel's. */
function assertFigures({ checkInDate, checkOutDate, nights, currency }) {
  const errors = {};
  const expected = nightsBetween(checkInDate, checkOutDate);
  if (nights !== undefined && nights !== expected) errors.nights = `Must equal the number of nights between check_in and check_out (${expected}).`;
  if (currency !== undefined && currency !== config.hotel.currency) errors.currency = `Must be ${config.hotel.currency}.`;
  if (Object.keys(errors).length) throw validationError(errors);
}

const guestInput = (g) =>
  g && {
    ...(g.first_name !== undefined ? { firstName: g.first_name } : {}),
    ...(g.last_name !== undefined ? { lastName: g.last_name } : {}),
    ...(g.email !== undefined ? { email: g.email } : {}),
    ...(g.phone !== undefined ? { phone: g.phone } : {}),
  };

/**
 * StayBook room id → PMS room, via the explicit mapping. frontdeskRoomId, when
 * StayBook also sends it, must agree with the mapping (catches stale copies).
 */
export async function resolveMappedRoom(staybookRoomId, frontdeskRoomId) {
  const mapping = await ExternalRoomMapping.findOne({ where: { sourceSystem: SYSTEM, externalRoomId: String(staybookRoomId) }, include: ["room"] });
  if (!mapping) {
    throw new AppError(422, "ROOM_NOT_MAPPED", `StayBook room ${staybookRoomId} is not mapped to a Frontdesk room. Ask the Frontdesk administrator to map it.`, {
      staybook_room_id: "No Frontdesk room is mapped to this StayBook room.",
    });
  }
  const { room } = mapping;
  if (frontdeskRoomId !== undefined && frontdeskRoomId !== room.id) {
    throw conflict("ROOM_MAPPING_MISMATCH", `StayBook room ${staybookRoomId} is mapped to Frontdesk room ${room.id}, not ${frontdeskRoomId}.`, {
      staybook_room_id: toId(staybookRoomId),
      frontdesk_room_id: room.id,
    });
  }
  if (!room.isActive || room.archivedAt) {
    throw conflict("ROOM_OUT_OF_SERVICE", `Room ${room.roomNumber} (StayBook room ${staybookRoomId}) is not in service at the Frontdesk.`, {
      staybook_room_id: toId(staybookRoomId),
      frontdesk_room_id: room.id,
    });
  }
  return room;
}

const money = (n) => `${config.hotel.currency} ${Number(n).toFixed(2)}`;

/** What the front desk sees on the reservation (no guest data). */
function deskNote(input, room) {
  const parts = [
    `StayBook ${input.booking_reference}: quoted ${money(input.total_amount)} for ${input.nights} night(s) (${money(input.nightly_rate)}/night).`,
    "Online payment was SIMULATED - collect payment at the front desk.",
  ];
  if (!sameAmount(input.nightly_rate, room.nightlyRate)) parts.push(`Frontdesk rate for room ${room.roomNumber} is ${money(room.nightlyRate)}/night.`);
  return parts.join(" ").slice(0, 500);
}

/** Response for StayBook: the acknowledgment / current state. */
async function view(link, transaction) {
  const reservation = await Reservation.findByPk(link.reservationId, { include: ["room"], transaction });
  const room = reservation.room;
  const assigned = room
    ? await ExternalRoomMapping.findOne({ where: { sourceSystem: SYSTEM, roomId: room.id }, attributes: ["externalRoomId"], transaction })
    : null;
  const assignedStaybookRoomId = assigned ? toId(assigned.externalRoomId) : null;
  const bookedStaybookRoomId = toId(link.externalRoomId);
  let roomAssignment = "PENDING";
  if (room) roomAssignment = assignedStaybookRoomId === bookedStaybookRoomId ? "AS_BOOKED" : "CHANGED_BY_FRONT_DESK";
  return {
    frontdesk_reservation_id: reservation.id,
    reservation_code: reservation.reservationCode,
    source_system: SYSTEM,
    source_booking_id: toId(link.sourceBookingId),
    booking_reference: link.bookingReference,
    hotel_id: toId(link.hotelId),
    staybook_room_id: bookedStaybookRoomId,
    frontdesk_room_id: room ? room.id : null,
    room_number: room ? room.roomNumber : null,
    room_type: reservation.roomType,
    room_assignment: roomAssignment,
    assigned_staybook_room_id: assignedStaybookRoomId,
    check_in: reservation.checkInDate,
    check_out: reservation.checkOutDate,
    guests: reservation.numGuests,
    nights: nightsBetween(reservation.checkInDate, reservation.checkOutDate),
    nightly_rate: amount(link.nightlyRate),
    total_amount: amount(link.totalAmount),
    currency: link.currency,
    frontdesk_nightly_rate: room ? amount(room.nightlyRate) : null,
    rate_matches_frontdesk: room && link.nightlyRate !== null ? sameAmount(room.nightlyRate, link.nightlyRate) : null,
    booking_status: link.bookingStatus,
    frontdesk_status: reservation.status,
    payment_mode: link.paymentMode,
    payment_recorded: false,
    sync_status: link.syncStatus,
    source_updated_at: link.sourceUpdatedAt,
    acknowledged_at: link.createdAt,
    last_synced_at: link.lastSyncedAt,
  };
}

/** :id in the path — the Frontdesk reservation id (digits) or the StayBook booking reference. */
async function findLink(id, { transaction, lock = false } = {}) {
  const where = /^\d{1,10}$/.test(id) ? { reservationId: Number(id) } : { bookingReference: id };
  const link = await ExternalBooking.findOne({
    where: { sourceSystem: SYSTEM, ...where },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!link) throw new AppError(404, "RESERVATION_NOT_FOUND", `No StayBook reservation ${id} in the Frontdesk.`);
  return link;
}

const existingLink = ({ source_booking_id: id, booking_reference: ref }) =>
  ExternalBooking.findOne({ where: { sourceSystem: SYSTEM, [Op.or]: [{ sourceBookingId: id }, { bookingReference: ref }] } });

const duplicate = async (input) => {
  const link = await existingLink(input);
  return conflict(
    "DUPLICATE_RESERVATION",
    `StayBook booking ${input.booking_reference} is already in the Frontdesk.`,
    link ? await view(link) : undefined
  );
};

// ── operations ───────────────────────────────────────────────────────────────

/**
 * New StayBook booking → CONFIRMED PMS reservation of the mapped room.
 * Lookups happen OUTSIDE the write transaction on purpose (see
 * availabilityService.peekRoomType: the transaction's first plain read must
 * come after the availability lock).
 */
export async function createFromStaybook(input) {
  assertHotel(input.hotel_id);
  translated(() => assertValidDates({ checkInDate: input.check_in, checkOutDate: input.check_out }));
  assertFigures({ checkInDate: input.check_in, checkOutDate: input.check_out, nights: input.nights, currency: input.currency });
  const room = await resolveMappedRoom(input.staybook_room_id, input.frontdesk_room_id);
  if (await existingLink(input)) throw await duplicate(input);

  try {
    return await withTransaction(null, async (t) => {
      const reservation = await createReservation(
        {
          guest: guestInput(input.guest),
          roomId: room.id,
          checkInDate: input.check_in,
          checkOutDate: input.check_out,
          numGuests: input.guests,
          externalReservationId: input.booking_reference,
          bookingReference: input.booking_reference,
          // StayBook payments are simulated: nothing has been collected.
          externalPaymentStatus: "UNPAID",
          notes: deskNote(input, room),
        },
        { source: SOURCE, transaction: t }
      );
      const now = new Date();
      const link = await ExternalBooking.create(
        {
          sourceSystem: SYSTEM,
          sourceBookingId: input.source_booking_id,
          bookingReference: input.booking_reference,
          reservationId: reservation.id,
          hotelId: input.hotel_id,
          externalRoomId: String(input.staybook_room_id),
          nightlyRate: input.nightly_rate,
          totalAmount: input.total_amount,
          currency: input.currency,
          bookingStatus: input.booking_status,
          paymentMode: input.payment_mode || PAYMENT_MODES[0],
          sourceUpdatedAt: input.updated_at,
          syncStatus: EXTERNAL_SYNC_STATUS.ACKNOWLEDGED,
          lastSyncedAt: now,
        },
        { transaction: t }
      );
      logger.info("staybook_reservation_acknowledged", { reservationId: reservation.id, bookingReference: input.booking_reference, roomId: room.id });
      return view(link, t);
    });
  } catch (err) {
    // Two simultaneous requests for the same booking: the unique indexes decide. The loser
    // may instead have queued on the room lock and found the room taken — by this very
    // booking — so a business refusal is re-checked before it is reported.
    if (err instanceof UniqueConstraintError) throw await duplicate(input);
    if (err instanceof AppError && err.status === 409 && (await existingLink(input))) throw await duplicate(input);
    throw translate(err);
  }
}

export const getStaybookReservation = async (id) => view(await findLink(id));

/**
 * A later StayBook revision. updated_at orders revisions: an older one is
 * refused (409 STALE_UPDATE), the same one is a no-op (safe retry), a newer
 * one is applied. Only fields that really changed reach the core, so a
 * status-only revision (LOCAL_CONFIRMED → ADMIN_CONFIRMED) is accepted even
 * after check-in. A different staybook_room_id moves the booking to the newly
 * mapped room (re-checked for availability); otherwise a room chosen by the
 * front desk is kept.
 */
export async function updateFromStaybook(id, input) {
  const link = await findLink(id);
  if (input.hotel_id !== undefined) assertHotel(input.hotel_id);
  const reservation = await Reservation.findByPk(link.reservationId);
  if ([RESERVATION_STATUS.CANCELLED, RESERVATION_STATUS.CHECKED_OUT].includes(reservation.status)) {
    throw conflict("RESERVATION_NOT_MODIFIABLE", `Reservation ${reservation.reservationCode} is ${reservation.status} and can no longer be changed.`, await view(link));
  }

  const checkInDate = input.check_in ?? reservation.checkInDate;
  const checkOutDate = input.check_out ?? reservation.checkOutDate;
  if (input.check_in !== undefined || input.check_out !== undefined) {
    translated(() => assertValidDates({ checkInDate, checkOutDate }, { allowPastCheckIn: checkInDate === reservation.checkInDate }));
  }
  assertFigures({ checkInDate, checkOutDate, nights: input.nights, currency: input.currency });

  const changes = {};
  if (checkInDate !== reservation.checkInDate) changes.checkInDate = checkInDate;
  if (checkOutDate !== reservation.checkOutDate) changes.checkOutDate = checkOutDate;
  if (input.guests !== undefined && input.guests !== reservation.numGuests) changes.numGuests = input.guests;
  let externalRoomId = link.externalRoomId;
  if (input.staybook_room_id !== undefined && String(input.staybook_room_id) !== link.externalRoomId) {
    const room = await resolveMappedRoom(input.staybook_room_id, input.frontdesk_room_id);
    if (room.id !== reservation.roomId) changes.roomId = room.id;
    externalRoomId = String(input.staybook_room_id);
  }

  try {
    return await withTransaction(null, async (t) => {
      // Locking read first: serialises concurrent revisions of the same booking.
      const locked = await findLink(String(link.reservationId), { transaction: t, lock: true });
      const incoming = input.updated_at.getTime();
      const stored = locked.sourceUpdatedAt ? locked.sourceUpdatedAt.getTime() : null;
      if (stored !== null && incoming < stored) {
        throw conflict("STALE_UPDATE", "A newer revision of this StayBook booking was already applied.", { source_updated_at: locked.sourceUpdatedAt });
      }
      if (stored === incoming) return view(locked, t); // this revision was already applied

      if (Object.keys(changes).length) {
        await updateReservation({ id: reservation.id }, changes, { transaction: t, syncedFromExternal: true });
      }
      if (input.guest && Object.keys(input.guest).length) {
        const current = await Reservation.findByPk(reservation.id, { include: ["guest"], transaction: t });
        await current.guest.update(guestInput(input.guest), { transaction: t });
      }
      const update = { externalRoomId, sourceUpdatedAt: input.updated_at, syncStatus: EXTERNAL_SYNC_STATUS.UPDATED, lastSyncedAt: new Date() };
      if (input.hotel_id !== undefined) update.hotelId = input.hotel_id;
      if (input.nightly_rate !== undefined) update.nightlyRate = input.nightly_rate;
      if (input.total_amount !== undefined) update.totalAmount = input.total_amount;
      if (input.currency !== undefined) update.currency = input.currency;
      if (input.booking_status !== undefined) update.bookingStatus = input.booking_status;
      await locked.update(update, { transaction: t });
      logger.info("staybook_reservation_updated", { reservationId: reservation.id, bookingReference: link.bookingReference, fields: Object.keys(changes) });
      return view(locked, t);
    });
  } catch (err) {
    throw translate(err);
  }
}

/**
 * Cancellation from StayBook. Repeating it is harmless: a reservation that is
 * already cancelled (from StayBook or at the front desk) is returned as is.
 * After check-in it is refused (409 RESERVATION_NOT_MODIFIABLE).
 */
export async function cancelFromStaybook(id, { reason, updated_at: updatedAt } = {}) {
  const link = await findLink(id);
  const reservation = await Reservation.findByPk(link.reservationId, { attributes: ["id", "status"] });
  const linkUpdate = () => ({
    bookingStatus: STAYBOOK_STATUS.CANCELLED,
    syncStatus: EXTERNAL_SYNC_STATUS.CANCELLED,
    lastSyncedAt: new Date(),
    ...(updatedAt && (!link.sourceUpdatedAt || updatedAt > link.sourceUpdatedAt) ? { sourceUpdatedAt: updatedAt } : {}),
  });
  if (reservation.status === RESERVATION_STATUS.CANCELLED) {
    if (link.syncStatus !== EXTERNAL_SYNC_STATUS.CANCELLED) await link.update(linkUpdate());
    return view(link);
  }
  try {
    return await withTransaction(null, async (t) => {
      await cancelReservation({ id: reservation.id }, reason || "Cancelled in StayBook", { transaction: t, syncedFromExternal: true });
      await link.update(linkUpdate(), { transaction: t });
      logger.info("staybook_reservation_cancelled", { reservationId: reservation.id, bookingReference: link.bookingReference });
      return view(link, t);
    });
  } catch (err) {
    // A simultaneous cancellation won the race: the outcome is the same.
    if (err instanceof AppError && err.code === "RESERVATION_NOT_MODIFIABLE") {
      const now = await Reservation.findByPk(reservation.id, { attributes: ["status"] });
      if (now.status === RESERVATION_STATUS.CANCELLED) return view(await findLink(id));
    }
    throw translate(err);
  }
}

/**
 * Authoritative availability of the MAPPED rooms for a stay — the PMS knows
 * what StayBook cannot: walk-ins, in-house guests, maintenance, rooms out of
 * service. Same rules as a front-desk booking (findAvailableRooms).
 */
export async function availableRooms({ check_in: checkInDate, check_out: checkOutDate, guests, hotel_id: hotelId }) {
  if (hotelId !== undefined) assertHotel(hotelId);
  translated(() => assertValidDates({ checkInDate, checkOutDate }));
  const nights = nightsBetween(checkInDate, checkOutDate);
  const mappings = await ExternalRoomMapping.findAll({ where: { sourceSystem: SYSTEM }, include: ["room"] });
  const free = new Set((await findAvailableRooms({ checkInDate, checkOutDate, numGuests: guests })).map((r) => r.id));

  const rooms = [];
  const unavailable = [];
  mappings
    .sort((a, b) => a.room.roomNumber.localeCompare(b.room.roomNumber, undefined, { numeric: true }))
    .forEach(({ externalRoomId, room }) => {
      const base = {
        staybook_room_id: toId(externalRoomId),
        frontdesk_room_id: room.id,
        room_number: room.roomNumber,
        room_type: room.roomType,
        capacity: room.capacity,
        nightly_rate: amount(room.nightlyRate),
      };
      if (free.has(room.id)) {
        rooms.push({ ...base, stay_total: multiplyMoney(room.nightlyRate, nights) });
        return;
      }
      let reason = "NOT_AVAILABLE"; // booked, occupied, or the room type is fully sold for a night
      if (!room.isActive || room.archivedAt) reason = "OUT_OF_SERVICE";
      else if (room.capacity < guests) reason = "CAPACITY_EXCEEDED";
      else if (room.status === ROOM_STATUS.MAINTENANCE) reason = "MAINTENANCE";
      unavailable.push({ ...base, reason });
    });

  return {
    hotel_id: toId(hotelId ?? config.integrations.staybook.hotelId),
    check_in: checkInDate,
    check_out: checkOutDate,
    nights,
    guests,
    currency: config.hotel.currency,
    rooms,
    unavailable_rooms: unavailable,
  };
}
