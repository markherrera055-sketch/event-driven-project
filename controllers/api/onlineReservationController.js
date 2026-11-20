/**
 * Online Reservations (StayBook) and staff notifications — staff API.
 * Open to every staff role (receptionists assign rooms, administrators
 * monitor); notification read state is per user.
 */
import { asyncHandler, ok, pagination } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { validationError } from "../../utils/errors.js";
import { RESERVATION_STATUS, NOTIFICATION_CATEGORY } from "../../models/index.js";
import * as online from "../../services/onlineReservationService.js";
import * as notifications from "../../services/staffNotificationService.js";

// ── Online reservations ──────────────────────────────────────────────────────

export const list = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    guest: v.string({ max: 100 }),
    reference: v.string({ max: 100 }),
    room: v.string({ max: 10 }),
    checkIn: v.date(),
    checkOut: v.date(),
    status: v.enum(Object.values(RESERVATION_STATUS)),
    view: v.enum(["upcoming", "arrivals", "cancelled"]),
  });
  const result = await online.listOnlineReservations({ ...q, ...pagination(req.query) }, req.user);
  ok(res, result.data, result.meta);
});

export const summary = asyncHandler(async (req, res) => ok(res, await online.onlineReservationSummary()));

export const show = asyncHandler(async (req, res) => ok(res, await online.getOnlineReservation(Number(req.params.id), req.user)));

/** Rooms held by online bookings for a date range (room-picker / walk-in warning). */
export const holds = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    checkIn: v.date({ required: true }),
    checkOut: v.date({ required: true }),
    excludeReservationId: v.int({ min: 1 }),
  });
  if (q.checkOut <= q.checkIn) throw validationError({ checkOut: "Check-out date must be after the check-in date." });
  ok(res, await online.roomHolds(q));
});

// ── Notifications ────────────────────────────────────────────────────────────

export const listNotifications = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    unread: v.bool(),
    problems: v.bool(),
    category: v.enum(Object.values(NOTIFICATION_CATEGORY)),
    reservationId: v.int({ min: 1 }),
  });
  const result = await notifications.listNotifications(req.user, { ...q, ...pagination(req.query, { defaultLimit: 20, maxLimit: 100 }) });
  ok(res, result.data, result.meta);
});

export const notificationSummary = asyncHandler(async (req, res) => ok(res, await notifications.notificationSummary(req.user)));

export const markRead = asyncHandler(async (req, res) => ok(res, await notifications.markRead(req.user, Number(req.params.id))));

export const markAllRead = asyncHandler(async (req, res) => {
  const input = validate(req.body || {}, { upToId: v.int({ min: 1 }), reservationId: v.int({ min: 1 }) });
  ok(res, await notifications.markAllRead(req.user, input));
});
