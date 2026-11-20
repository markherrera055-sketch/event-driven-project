/**
 * Online Reservations — the staff view of bookings received from StayBook.
 *
 * Read-only over the EXISTING records: external_bookings (StayBook ids, quote,
 * sync state) joined 1-to-1 with reservations (the ordinary Frontdesk
 * reservation every other screen and the availability rules use). Nothing is
 * copied, so there is a single reservation record per booking.
 *
 *   listOnlineReservations   the Online Reservations page (search + filters)
 *   getOnlineReservation     details + booking / change / cancellation history
 *   roomHolds                rooms held by online bookings for a date range
 *                            (warning in the room picker and walk-in form)
 *   onlineReservationSummary dashboard card
 *   staybookSyncIssues       admin: refused StayBook requests, failed webhooks
 */
import { Op } from "sequelize";
import {
  sequelize,
  ExternalBooking,
  Reservation,
  Guest,
  Room,
  ExternalRoomMapping,
  IntegrationEvent,
  IntegrationOutbox,
  IntegrationRequest,
  StaffNotification,

  EXTERNAL_SYSTEMS,
  ACTIVE_RESERVATION_STATUSES,
  RESERVATION_STATUS,
  OUTBOX_STATUS,
  OUTBOX_TARGETS,
  PROBLEM_NOTIFICATION_CATEGORIES,
} from "../models/index.js";
import { notFound } from "../utils/errors.js";
import { pageMeta } from "../utils/http.js";
import { nightsBetween, today, addDays } from "../utils/dates.js";

const SYSTEM = EXTERNAL_SYSTEMS.STAYBOOK;
const amount = (v) => (v === null || v === undefined ? null : Number(v));
const fullName = (g) => (g ? [g.firstName, g.lastName].filter(Boolean).join(" ") : null);

const include = [
  {
    model: Reservation,
    as: "reservation",
    required: true,
    include: [
      { model: Guest, as: "guest", required: true },
      { model: Room, as: "room", required: false },
    ],
  },
];

/** Latest webhook delivery to StayBook per reservation (outbound sync state). */
async function latestWebhooks(reservationIds) {
  if (!reservationIds.length) return new Map();
  const rows = await IntegrationOutbox.findAll({
    where: { target: OUTBOX_TARGETS.BOOKING },
    include: [{ model: IntegrationEvent, as: "event", required: true, where: { aggregateType: "RESERVATION", aggregateId: reservationIds }, attributes: ["aggregateId"] }],
    order: [["id", "DESC"]],
  });
  const map = new Map();
  for (const r of rows) {
    const id = r.event.aggregateId;
    if (!map.has(id)) map.set(id, { id: r.id, event: r.eventType, status: r.status, attempts: r.attempts, lastError: r.lastError, at: r.sentAt || r.updatedAt });
  }
  return map;
}

/** Unread notifications per reservation for this user. */
async function unreadCounts(userId, reservationIds) {
  if (!userId || !reservationIds.length) return new Map();
  const rows = await StaffNotification.findAll({
    where: {
      reservationId: reservationIds,
      id: { [Op.notIn]: sequelize.literal(`(SELECT r.notification_id FROM staff_notification_reads r WHERE r.user_id = ${Number(userId)})`) },
    },
    attributes: ["reservationId", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    group: ["reservationId"],
    raw: true,
  });
  return new Map(rows.map((r) => [r.reservationId, Number(r.n)]));
}

/**
 * Combined synchronisation state shown to staff:
 *   inbound  — last change received from StayBook (ACKNOWLEDGED / UPDATED / CANCELLED)
 *   outbound — last front-desk change sent to StayBook (webhook PENDING / SENT / FAILED)
 *   health   — OK | WEBHOOK_PENDING | WEBHOOK_FAILED
 */
const syncJSON = (link, webhook) => ({
  inbound: link.syncStatus,
  lastSyncedAt: link.lastSyncedAt,
  outbound: webhook || null,
  health: webhook?.status === OUTBOX_STATUS.FAILED ? "WEBHOOK_FAILED" : webhook?.status === OUTBOX_STATUS.PENDING ? "WEBHOOK_PENDING" : "OK",
});

async function bookedRoomNumbers(links) {
  const ids = [...new Set(links.map((l) => l.externalRoomId).filter(Boolean))];
  if (!ids.length) return new Map();
  const maps = await ExternalRoomMapping.findAll({ where: { sourceSystem: SYSTEM, externalRoomId: ids }, include: [{ model: Room, as: "room", attributes: ["roomNumber"] }] });
  return new Map(maps.map((m) => [m.externalRoomId, m.room.roomNumber]));
}

function rowJSON(link, { webhook, unread = 0, bookedRoomNumber } = {}) {
  const r = link.reservation;
  return {
    id: r.id, // the Frontdesk reservation id (links to /front-desk/reservations/:id)
    externalBookingId: link.id,
    reservationCode: r.reservationCode,
    bookingReference: link.bookingReference,
    sourceBookingId: link.sourceBookingId,
    guestName: fullName(r.guest),
    room: r.room ? { id: r.room.id, roomNumber: r.room.roomNumber, roomType: r.room.roomType, status: r.room.status } : null,
    roomType: r.roomType,
    staybookRoomId: link.externalRoomId,
    bookedRoomNumber: bookedRoomNumber ?? null,
    roomChangedByFrontDesk: !!(r.room && bookedRoomNumber && bookedRoomNumber !== r.room.roomNumber),
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    nights: nightsBetween(r.checkInDate, r.checkOutDate),
    numGuests: r.numGuests,
    status: r.status,
    bookingStatus: link.bookingStatus,
    paymentMode: link.paymentMode,
    quote: { nightlyRate: amount(link.nightlyRate), totalAmount: amount(link.totalAmount), currency: link.currency },
    receivedAt: link.createdAt,
    sync: syncJSON(link, webhook),
    unreadNotifications: unread,
  };
}

/**
 * Filters: guest (name), reference (StayBook reference, booking id or RSV code),
 * room (number), checkIn / checkOut (exact date), status (reservation status),
 * view: upcoming | arrivals (today) | cancelled | attention (webhook failed).
 */
export async function listOnlineReservations({ guest, reference, room, checkIn, checkOut, status, view, page = 1, limit = 25, offset = 0 } = {}, user) {
  const where = { sourceSystem: SYSTEM };
  const and = [];
  const like = (v) => ({ [Op.like]: `%${v}%` });
  if (guest) {
    and.push({
      [Op.or]: [
        { "$reservation.guest.first_name$": like(guest) },
        { "$reservation.guest.last_name$": like(guest) },
        sequelize.where(sequelize.fn("CONCAT", sequelize.col("reservation->guest.first_name"), " ", sequelize.col("reservation->guest.last_name")), like(guest)),
      ],
    });
  }
  if (reference) and.push({ [Op.or]: [{ bookingReference: like(reference) }, { sourceBookingId: reference }, { "$reservation.reservation_code$": like(reference) }] });
  if (room) and.push({ "$reservation.room.room_number$": like(room) });
  if (checkIn) and.push({ "$reservation.check_in_date$": checkIn });
  if (checkOut) and.push({ "$reservation.check_out_date$": checkOut });
  if (status) and.push({ "$reservation.status$": status });
  const d = today();
  if (view === "upcoming") and.push({ "$reservation.status$": RESERVATION_STATUS.CONFIRMED, "$reservation.check_in_date$": { [Op.gte]: d } });
  if (view === "arrivals") and.push({ "$reservation.status$": RESERVATION_STATUS.CONFIRMED, "$reservation.check_in_date$": { [Op.lte]: d } });
  if (view === "cancelled") and.push({ "$reservation.status$": RESERVATION_STATUS.CANCELLED });
  if (and.length) where[Op.and] = and;

  const order = view === "upcoming" || view === "arrivals" ? [[{ model: Reservation, as: "reservation" }, "checkInDate", "ASC"], ["id", "ASC"]] : [["id", "DESC"]];
  const { rows, count } = await ExternalBooking.findAndCountAll({ where, include, order, limit, offset, distinct: true, subQuery: false });
  const ids = rows.map((l) => l.reservationId);
  const [webhooks, unread, booked] = await Promise.all([latestWebhooks(ids), unreadCounts(user?.id, ids), bookedRoomNumbers(rows)]);
  return {
    data: rows.map((l) => rowJSON(l, { webhook: webhooks.get(l.reservationId), unread: unread.get(l.reservationId) || 0, bookedRoomNumber: booked.get(l.externalRoomId) })),
    meta: pageMeta({ page, limit }, count),
  };
}

/** What happened to the booking, oldest first: received, changed, cancelled, front-desk changes sent back, notifications. */
async function history(link) {
  const [events, notifications, deliveries] = await Promise.all([
    IntegrationEvent.findAll({ where: { aggregateType: "RESERVATION", aggregateId: link.reservationId }, order: [["id", "ASC"]] }),
    StaffNotification.findAll({ where: { reservationId: link.reservationId }, order: [["id", "ASC"]] }),
    IntegrationOutbox.findAll({
      where: { target: OUTBOX_TARGETS.BOOKING },
      include: [{ model: IntegrationEvent, as: "event", required: true, where: { aggregateType: "RESERVATION", aggregateId: link.reservationId }, attributes: ["eventId"] }],
      order: [["id", "ASC"]],
    }),
  ]);
  return {
    events: events.map((e) => ({
      eventId: e.eventId,
      type: e.eventType,
      // origin BOOKING = the change came from StayBook; PMS = made at the front desk
      origin: e.payload?.origin === "BOOKING" ? "STAYBOOK" : "FRONT_DESK",
      status: e.payload?.status ?? null,
      roomNumber: e.payload?.room_number ?? null,
      checkInDate: e.payload?.check_in_date ?? null,
      checkOutDate: e.payload?.check_out_date ?? null,
      numGuests: e.payload?.number_of_guests ?? null,
      occurredAt: e.occurredAt,
    })),
    notifications: notifications.map((n) => ({ id: n.id, category: n.category, title: n.title, message: n.message, createdAt: n.createdAt })),
    webhooks: deliveries.map((o) => ({ id: o.id, eventId: o.event.eventId, event: o.eventType, status: o.status, attempts: o.attempts, lastError: o.lastError, sentAt: o.sentAt, createdAt: o.createdAt })),
  };
}

/** :id = Frontdesk reservation id of a StayBook booking. */
export async function getOnlineReservation(reservationId, user) {
  const link = await ExternalBooking.findOne({ where: { sourceSystem: SYSTEM, reservationId }, include });
  if (!link) throw notFound("Online reservation");
  const [webhooks, unread, booked, hist] = await Promise.all([
    latestWebhooks([reservationId]),
    unreadCounts(user?.id, [reservationId]),
    bookedRoomNumbers([link]),
    history(link),
  ]);
  return {
    ...rowJSON(link, { webhook: webhooks.get(reservationId), unread: unread.get(reservationId) || 0, bookedRoomNumber: booked.get(link.externalRoomId) }),
    sourceUpdatedAt: link.sourceUpdatedAt,
    notes: link.reservation.notes,
    cancelledAt: link.reservation.cancelledAt,
    cancellationReason: link.reservation.cancellationReason,
    history: hist,
  };
}

/**
 * Rooms held by active online bookings on any night of [checkIn, checkOut),
 * excluding one reservation (the one being edited). Same overlap rule as the
 * availability check; a booking ending on checkIn does not hold the room.
 */
export async function roomHolds({ checkIn, checkOut, excludeReservationId }) {
  const where = {
    status: ACTIVE_RESERVATION_STATUSES,
    roomId: { [Op.ne]: null },
    checkInDate: { [Op.lt]: checkOut },
    checkOutDate: { [Op.gt]: checkIn },
  };
  if (excludeReservationId) where.id = { [Op.ne]: excludeReservationId };
  const rows = await Reservation.findAll({
    where,
    include: [
      { model: ExternalBooking, as: "externalBooking", required: true, where: { sourceSystem: SYSTEM } },
      { model: Room, as: "room", required: true },
      { model: Guest, as: "guest", required: true },
    ],
    order: [["checkInDate", "ASC"]],
  });
  return rows.map((r) => ({
    roomId: r.room.id,
    roomNumber: r.room.roomNumber,
    roomType: r.room.roomType,
    reservationId: r.id,
    reservationCode: r.reservationCode,
    bookingReference: r.externalBooking.bookingReference,
    guestName: fullName(r.guest),
    checkInDate: r.checkInDate,
    checkOutDate: r.checkOutDate,
    status: r.status,
  }));
}

/** Dashboard card: online arrivals and problems at a glance. */
export async function onlineReservationSummary() {
  const d = today();
  const base = { sourceSystem: SYSTEM };
  const withRes = (where) => ({ where: base, include: [{ model: Reservation, as: "reservation", required: true, where, attributes: [] }] });
  const since = new Date(Date.now() - 7 * 86400000);
  const [arrivalsToday, upcoming, receivedToday, problems7d] = await Promise.all([
    ExternalBooking.count(withRes({ status: RESERVATION_STATUS.CONFIRMED, checkInDate: d })),
    ExternalBooking.count(withRes({ status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.gte]: d } })),
    ExternalBooking.count({ where: { ...base, createdAt: { [Op.gte]: new Date(`${d}T00:00:00`) } } }),
    StaffNotification.count({ where: { category: PROBLEM_NOTIFICATION_CATEGORIES, createdAt: { [Op.gte]: since } } }),
  ]);
  const next = await ExternalBooking.findAll({
    where: base,
    include: [
      {
        model: Reservation,
        as: "reservation",
        required: true,
        where: { status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.between]: [d, addDays(d, 7)] } },
        include: [
          { model: Guest, as: "guest", required: true },
          { model: Room, as: "room", required: false },
        ],
      },
    ],
    order: [[{ model: Reservation, as: "reservation" }, "checkInDate", "ASC"]],
    limit: 5,
  });
  return {
    arrivalsToday,
    upcoming,
    receivedToday,
    problemsLast7Days: problems7d,
    nextArrivals: next.map((l) => rowJSON(l)),
  };
}

const STAYBOOK_PATH = "/api/v1/integrations/staybook/%";

/** Admin Console: what failed between StayBook and the Frontdesk. */
export async function staybookSyncIssues({ limit = 50 } = {}) {
  const [refused, refusedTotal, failedWebhooks] = await Promise.all([
    IntegrationRequest.findAll({
      where: { path: { [Op.like]: STAYBOOK_PATH }, responseStatus: { [Op.gte]: 400 } },
      order: [["id", "DESC"]],
      limit,
    }),
    IntegrationRequest.count({ where: { path: { [Op.like]: STAYBOOK_PATH }, responseStatus: { [Op.gte]: 400 } } }),
    IntegrationOutbox.findAll({
      where: { target: OUTBOX_TARGETS.BOOKING, status: OUTBOX_STATUS.FAILED },
      include: [{ model: IntegrationEvent, as: "event", required: true, attributes: ["eventId", "aggregateId"] }],
      order: [["id", "DESC"]],
      limit,
    }),
  ]);
  // Only webhooks about StayBook bookings.
  const links = await ExternalBooking.findAll({
    where: { sourceSystem: SYSTEM, reservationId: failedWebhooks.map((o) => o.event.aggregateId).filter(Boolean) },
    attributes: ["reservationId", "bookingReference"],
  });
  const refOf = new Map(links.map((l) => [l.reservationId, l.bookingReference]));
  return {
    refusedRequests: refused.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.responseStatus,
      code: r.responseBody?.error?.code ?? null,
      message: r.responseBody?.error?.message ?? null,
      idempotencyKey: r.idempotencyKey,
      createdAt: r.createdAt,
    })),
    refusedTotal,
    failedWebhooks: failedWebhooks
      .filter((o) => refOf.has(o.event.aggregateId))
      .map((o) => ({
        id: o.id,
        event: o.eventType,
        eventId: o.event.eventId,
        reservationId: o.event.aggregateId,
        bookingReference: refOf.get(o.event.aggregateId),
        attempts: o.attempts,
        lastError: o.lastError,
        updatedAt: o.updatedAt,
      })),
  };
}


