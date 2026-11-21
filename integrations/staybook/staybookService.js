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
import crypto from "crypto";
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
  READY_ROOM_STATUSES,
  NOTIFICATION_CATEGORY,
  occupancyStatusOf,
} from "../../models/index.js";
import { AppError, conflict, validationError } from "../../utils/errors.js";
import { withTransaction } from "../../services/tx.js";
import { createReservation, updateReservation, cancelReservation } from "../../services/reservationService.js";
import { assertValidDates, findAvailableRooms } from "../../services/availabilityService.js";
import { nightsBetween } from "../../utils/dates.js";
import { multiplyMoney, sameAmount } from "../../utils/money.js";
import { notify } from "../../services/staffNotificationService.js";
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

// ── staff notifications ──────────────────────────────────────────────────────
// Written in the same transaction as the booking change (so they exist exactly
// when the change was committed) and de-duplicated by key, so a repeated
// StayBook delivery never notifies twice. Guest name, room and reference
// only — no contact details.

const fullName = (guest) => (guest ? [guest.firstName, guest.lastName].filter(Boolean).join(" ") : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function notifyBooking(kind, link, transaction, { changes = [], reason } = {}) {
  const reservation = await Reservation.findByPk(link.reservationId, { include: ["guest", "room"], transaction });
  const room = reservation.room;
  const guest = fullName(reservation.guest);
  const roomText = room ? `Room ${room.roomNumber}` : "no room assigned";
  const stay = `${reservation.checkInDate} → ${reservation.checkOutDate}`;
  const ref = link.bookingReference;
  const base = {
    reservationId: reservation.id,
    externalBookingId: link.id,
    bookingReference: ref,
    roomNumber: room ? room.roomNumber : null,
    guestName: guest,
  };
  const details = {
    reservation_code: reservation.reservationCode,
    room_type: reservation.roomType,
    check_in: reservation.checkInDate,
    check_out: reservation.checkOutDate,
    guests: reservation.numGuests,
    booking_status: link.bookingStatus,
  };
  if (kind === "NEW") {
    return notify(
      {
        ...base,
        category: NOTIFICATION_CATEGORY.ONLINE_RESERVATION_NEW,
        title: `New online reservation · ${roomText}`,
        message: `${guest} booked ${roomText} (${reservation.roomType}) for ${stay}, ${plural(reservation.numGuests, "guest")}. StayBook ${ref} · ${reservation.reservationCode}. The room is held for these dates.`,
        details,
        dedupeKey: `STAYBOOK:NEW:${link.id}`,
      },
      { transaction }
    );
  }
  if (kind === "UPDATED") {
    return notify(
      {
        ...base,
        category: NOTIFICATION_CATEGORY.ONLINE_RESERVATION_UPDATED,
        title: `Online reservation updated · ${ref}`,
        message: `${guest} · ${roomText} · ${stay} · ${plural(reservation.numGuests, "guest")}. Changed: ${changes.length ? changes.join(", ") : "booking details"}. ${reservation.reservationCode}.`,
        details: { ...details, changes },
        dedupeKey: `STAYBOOK:UPDATED:${link.id}:${link.sourceUpdatedAt ? new Date(link.sourceUpdatedAt).getTime() : Date.now()}`,
      },
      { transaction }
    );
  }
  return notify(
    {
      ...base,
      category: NOTIFICATION_CATEGORY.ONLINE_RESERVATION_CANCELLED,
      title: `Online reservation cancelled · ${ref}`,
      message: `${guest} cancelled ${roomText}, ${stay} on StayBook.${room ? ` Room ${room.roomNumber} is released for these dates.` : ""} ${reservation.reservationCode} is kept as CANCELLED.`,
      details: { ...details, reason: reason || null },
      dedupeKey: `STAYBOOK:CANCELLED:${link.id}`,
    },
    { transaction }
  );
}

/** Human-readable list of what a StayBook revision changed (for the notification). */
function describeChanges(changes, input) {
  const out = [];
  if (changes.checkInDate) out.push(`check-in ${changes.checkInDate}`);
  if (changes.checkOutDate) out.push(`check-out ${changes.checkOutDate}`);
  if (changes.numGuests !== undefined) out.push(`guests ${changes.numGuests}`);
  if (changes.roomId !== undefined) out.push("room");
  if (input.guest && Object.keys(input.guest).length) out.push("guest details");
  if (input.nightly_rate !== undefined || input.total_amount !== undefined) out.push("quoted price");
  if (input.booking_status !== undefined) out.push(`StayBook status ${input.booking_status}`);
  return out;
}

/** Room conflicts: StayBook asked for a room the Frontdesk has already given to someone else. */
const CONFLICT_CODES = new Set(["ROOM_UNAVAILABLE", "NO_AVAILABILITY", "ROOM_OCCUPIED", "ROOM_UNDER_MAINTENANCE"]);
/** Refusals that are not problems: already synced, an older revision, a request still running. */
const NOT_A_FAILURE = new Set(["DUPLICATE_RESERVATION", "STALE_UPDATE", "REQUEST_IN_PROGRESS"]);
const OPERATION_TEXT = { create: "new booking", update: "booking change", cancel: "cancellation" };
const safeRef = (v) => ((typeof v === "string" || typeof v === "number") && /^[A-Za-z0-9._:-]{1,100}$/.test(String(v)) ? String(v) : null);
const safeDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const safeName = (g) => {
  if (!g || typeof g !== "object") return null;
  const part = (v) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
  return [part(g.first_name), part(g.last_name)].filter(Boolean).join(" ") || null;
};

/**
 * A StayBook request was refused (4xx): notify the front desk so the problem
 * is seen and fixed (e.g. map the room, free the room, contact the guest).
 * Runs after the failed transaction rolled back. Never throws: reporting must
 * not change the answer StayBook receives.
 *   operation: create | update | cancel;  id: the {id} path parameter (update / cancel)
 */
export async function recordSyncFailure({ operation, id, body, err, idempotencyKey }) {
  if (!(err instanceof AppError) || err.status < 400 || err.status >= 500 || NOT_A_FAILURE.has(err.code)) return false;
  try {
    const b = body && typeof body === "object" ? body : {};
    const link = id
      ? await ExternalBooking.findOne({ where: { sourceSystem: SYSTEM, ...(/^\d{1,10}$/.test(id) ? { reservationId: Number(id) } : { bookingReference: id }) } })
      : null;
    const reservation = link ? await Reservation.findByPk(link.reservationId, { include: ["guest", "room"] }) : null;
    const reference = link?.bookingReference ?? safeRef(b.booking_reference) ?? safeRef(id);
    let roomNumber = reservation?.room?.roomNumber ?? null;
    const staybookRoomId = safeRef(b.staybook_room_id);
    if (staybookRoomId) {
      const mapping = await ExternalRoomMapping.findOne({ where: { sourceSystem: SYSTEM, externalRoomId: staybookRoomId }, include: ["room"] });
      if (mapping) roomNumber = mapping.room.roomNumber;
    }
    const guestName = fullName(reservation?.guest) || safeName(b.guest);
    const checkIn = safeDate(b.check_in) ?? reservation?.checkInDate ?? null;
    const checkOut = safeDate(b.check_out) ?? reservation?.checkOutDate ?? null;
    const isConflict = CONFLICT_CODES.has(err.code);
    const category = isConflict ? NOTIFICATION_CATEGORY.ROOM_CONFLICT : NOTIFICATION_CATEGORY.SYNC_FAILED;
    const what = OPERATION_TEXT[operation] || "request";
    const who = [
      guestName,
      roomNumber ? `Room ${roomNumber}` : staybookRoomId ? `StayBook room ${staybookRoomId}` : null,
      checkIn && checkOut ? `${checkIn} → ${checkOut}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    await notify({
      category,
      title: isConflict ? `Room conflict · ${reference || "StayBook booking"}` : `StayBook sync failed · ${reference || "unknown booking"}`,
      message: isConflict
        ? `StayBook sent a ${what}${who ? ` (${who})` : ""}, but the room is already taken for those dates. Nothing was changed in the Frontdesk; contact the guest or StayBook. ${err.message}`
        : `StayBook's ${what}${who ? ` (${who})` : ""} was refused: ${err.message} (${err.code}). Nothing was changed in the Frontdesk.`,
      reservationId: link?.reservationId ?? null,
      externalBookingId: link?.id ?? null,
      bookingReference: reference,
      roomNumber,
      guestName,
      details: {
        operation,
        http_status: err.status,
        error_code: err.code,
        error_message: err.message,
        staybook_room_id: staybookRoomId,
        check_in: checkIn,
        check_out: checkOut,
        conflict_with: err.details?.protected_by ?? null,
        field_errors: err.code === "VALIDATION_ERROR" ? err.details ?? null : null,
      },
      dedupeKey: `STAYBOOK:${category}:${idempotencyKey || crypto.randomUUID()}`,
    });
    logger.warn("staybook_sync_refused", { operation, code: err.code, bookingReference: reference });
    return true;
  } catch (e) {
    logger.error("staybook_sync_failure_not_recorded", { operation, code: err.code, error: e.message });
    return false;
  }
}

/**
 * A webhook to StayBook failed after every retry (called by the outbox worker).
 * Only for StayBook bookings; one notification per exhausted delivery.
 */
export async function recordWebhookFailure(row) {
  try {
    const reservationId = Number(row.payload?.reservation_id);
    if (!reservationId) return false;
    const link = await ExternalBooking.findOne({ where: { sourceSystem: SYSTEM, reservationId } });
    if (!link) return false;
    const reservation = await Reservation.findByPk(reservationId, { include: ["guest", "room"] });
    await notify({
      category: NOTIFICATION_CATEGORY.SYNC_FAILED,
      title: `StayBook not updated · ${link.bookingReference}`,
      message: `StayBook could not be told about ${row.eventType} for ${link.bookingReference} (${reservation.reservationCode}) after ${plural(row.attempts, "attempt")}: ${row.lastError || "no answer"}. An administrator can re-send it from Admin Console → Integrations.`,
      reservationId,
      externalBookingId: link.id,
      bookingReference: link.bookingReference,
      roomNumber: reservation.room?.roomNumber ?? null,
      guestName: fullName(reservation.guest),
      details: {
        operation: "webhook",
        outbox_id: row.id,
        event: row.eventType,
        event_id: row.payload?.event_id ?? null,
        attempts: row.attempts,
        last_error: row.lastError,
        http_status: row.lastResponseStatus,
      },
      dedupeKey: `STAYBOOK:WEBHOOK_FAILED:${row.id}:${Date.now()}`,
    });
    return true;
  } catch (e) {
    logger.error("staybook_webhook_failure_not_recorded", { outboxId: row.id, error: e.message });
    return false;
  }
}

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
      await notifyBooking("NEW", link, t);
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
      await notifyBooking("UPDATED", locked, t, { changes: describeChanges(changes, input) });
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
    if (link.syncStatus !== EXTERNAL_SYNC_STATUS.CANCELLED) {
      await withTransaction(null, async (t) => {
        await link.update(linkUpdate(), { transaction: t });
        await notifyBooking("CANCELLED", link, t, { reason });
      });
    }
    return view(link);
  }
  try {
    return await withTransaction(null, async (t) => {
      await cancelReservation({ id: reservation.id }, reason || "Cancelled in StayBook", { transaction: t, syncedFromExternal: true });
      await link.update(linkUpdate(), { transaction: t });
      await notifyBooking("CANCELLED", link, t, { reason });
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

/**
 * Room sync (pull): current state of every mapped room, so StayBook can show
 * whether a room is ready right now. A room is ready_for_guest only when it is
 * in service and clean (VACANT_CLEAN): after a checkout it stays VACANT_DIRTY
 * until RoomCare confirms the cleaning (or the front desk marks it clean).
 */
export async function mappedRoomStates() {
  const mappings = await ExternalRoomMapping.findAll({ where: { sourceSystem: SYSTEM }, include: ["room"] });
  return {
    hotel_id: toId(config.integrations.staybook.hotelId),
    currency: config.hotel.currency,
    generated_at: new Date().toISOString(),
    rooms: mappings
      .filter((m) => m.room)
      .sort((a, b) => a.room.roomNumber.localeCompare(b.room.roomNumber, undefined, { numeric: true }))
      .map(({ externalRoomId, room }) => {
        const inService = !!room.isActive && !room.archivedAt;
        return {
          staybook_room_id: toId(externalRoomId),
          frontdesk_room_id: room.id,
          room_number: room.roomNumber,
          room_type: room.roomType,
          capacity: room.capacity,
          nightly_rate: amount(room.nightlyRate),
          description: room.description ?? null,
          amenities: Array.isArray(room.amenities) ? room.amenities : [],
          in_service: inService,
          room_status: room.status,
          occupancy_status: occupancyStatusOf(room.status),
          ready_for_guest: inService && READY_ROOM_STATUSES.includes(room.status),
          last_cleaned_at: room.lastCleanedAt ?? null,
          status_changed_at: room.statusChangedAt ?? null,
        };
      }),
  };
}
