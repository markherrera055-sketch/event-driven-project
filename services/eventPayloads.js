/**
 * Builders for published event payloads (the external contract, snake_case).
 * The integration layer adds `event`, `event_id` and `occurred_at` on top.
 * Only references and statuses are included — never guest contact details or
 * identity data.
 */
import { RESERVATION_SOURCE } from "../models/index.js";
import { config } from "../config/index.js";

/** External name of where a reservation came from. */
export const reservationSourceName = (source) => (source === RESERVATION_SOURCE.RESERVATION_SYSTEM ? "BOOKING" : "FRONT_DESK");

const maskedName = (guest) => (guest ? `${guest.firstName.charAt(0)}. ${guest.lastName}` : null);

/** Common reservation fields. origin = the system whose action caused the event (used to avoid echoing a change back). */
export const reservationData = (reservation, room, { origin = "PMS" } = {}) => ({
  origin,
  reservation_id: reservation.id,
  reservation_code: reservation.reservationCode,
  external_reservation_id: reservation.externalReservationId ?? null,
  booking_reference: reservation.bookingReference ?? null,
  source: reservationSourceName(reservation.source),
  status: reservation.status,
  guest_id: reservation.guestId,
  room_type: reservation.roomType,
  room_id: room ? room.id : null,
  room_number: room ? room.roomNumber : null,
  check_in_date: reservation.checkInDate,
  check_out_date: reservation.checkOutDate,
  number_of_guests: reservation.numGuests,
});

export const guestCheckedInData = (stay, reservation, room, guest) => ({
  ...reservationData(reservation, room),
  stay_id: stay.id,
  guest_display_name: maskedName(guest),
  checked_in_at: stay.checkInAt,
});

/** folio: result of folioService.getFolio (camelCase) → snake_case summary. */
export const folioSummaryData = (folio) => ({
  currency: config.hotel.currency,
  room_charges: folio.totals.roomCharges,
  restaurant_charges: folio.totals.restaurantCharges,
  other_charges: folio.totals.otherCharges,
  adjustments: folio.totals.adjustments,
  total_charges: folio.totals.totalCharges,
  payments: folio.totals.payments,
  balance: folio.totals.balance,
});

export const guestCheckedOutData = (stay, reservation, room, guest, folio) => ({
  ...reservationData(reservation, room),
  stay_id: stay.id,
  guest_display_name: maskedName(guest),
  checked_in_at: stay.checkInAt,
  checked_out_at: stay.checkOutAt,
  folio: folioSummaryData(folio),
});

/** Sent to Housekeeping so it can create a cleaning task. reason: CHECKOUT | ROOM_MOVE */
export const roomVacatedData = ({ reservation, stay, room, at, reason }) => ({
  reservation_id: reservation.id,
  reservation_code: reservation.reservationCode,
  stay_id: stay.id,
  room_id: room.id,
  room_number: room.roomNumber,
  room_type: room.roomType,
  guest_id: reservation.guestId,
  checkout_time: at,
  reason,
});

export const roomStatusChangedData = (room, from, to, { reason, source, reference }) => ({
  room_id: room.id,
  room_number: room.roomNumber,
  from_status: from,
  to_status: to,
  reason,
  source,
  reference: reference ?? null,
});

export const roomCleanedData = (room, { externalTaskId, completedBy, completedAt, origin }) => ({
  origin,
  room_id: room.id,
  room_number: room.roomNumber,
  room_status: room.status,
  external_task_id: externalTaskId ?? null,
  completed_by: completedBy ?? null,
  completed_at: completedAt,
});

export const roomChargePostedData = (charge, stay, reservation, room) => ({
  charge_id: charge.id,
  source_system: charge.sourceSystem,
  external_transaction_id: charge.externalTransactionId,
  reservation_id: reservation.id,
  stay_id: stay.id,
  room_number: room.roomNumber,
  category: charge.category,
  description: charge.description,
  amount: Number(charge.amount),
  currency: config.hotel.currency,
  transaction_date: charge.transactionAt,
});

/**
 * Sent to the POS when the front desk decides on one of its purchase
 * notifications. status: ADDED_TO_FOLIO | REJECTED. No guest names.
 */
export const posOrderReviewedData = (order, { orderRef, reservation, room } = {}) => ({
  pos_order_id: order.id,
  order_ref: orderRef,
  restaurant_id: order.restaurantId,
  external_order_id: order.externalOrderId,
  status: order.status,
  reservation_id: reservation?.id ?? null,
  reservation_code: reservation?.reservationCode ?? null,
  stay_id: order.matchedStayId ?? null,
  room_number: room?.roomNumber ?? null,
  charge_id: order.stayChargeId ?? null,
  amount: Number(order.total),
  currency: order.currency,
  reviewed_at: order.reviewedAt,
  rejection_reason: order.rejectionReason ?? null,
});

export const guestFolioUpdatedData = (folio, cause) => ({
  reservation_id: folio.reservationId,
  stay_id: folio.stayId,
  room_number: folio.roomNumber,
  cause,
  folio: folioSummaryData(folio),
});
