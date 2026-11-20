/**
 * Domain events raised by the core Frontdesk / PMS services. The core does not
 * know which external systems exist: the integration layer subscribes at
 * start-up, records each event in integration_events and turns it into
 * webhook deliveries (integration_outbox) in the SAME transaction as the
 * business change — so an event is never published for a change that was
 * rolled back, and never lost for one that was committed.
 *
 * Payloads (services/eventPayloads.js) are the published integration contract:
 * snake_case, references and statuses only, never guest contact or ID data.
 */
const subscribers = [];

/** Called by the integration layer at start-up. handler(eventType, payload, { transaction }) */
export const subscribe = (handler) => {
  subscribers.push(handler);
};

export const emit = async (eventType, payload, { transaction } = {}) => {
  for (const handler of subscribers) {
    await handler(eventType, payload, { transaction });
  }
};

export const EVENTS = Object.freeze({
  RESERVATION_CREATED: "ReservationCreated",
  RESERVATION_UPDATED: "ReservationUpdated",
  RESERVATION_CANCELLED: "ReservationCancelled",
  GUEST_CHECKED_IN: "GuestCheckedIn",
  GUEST_CHECKED_OUT: "GuestCheckedOut",
  ROOM_VACATED: "RoomVacated",
  ROOM_STATUS_CHANGED: "RoomStatusChanged",
  CLEANING_TASK_CREATED: "CleaningTaskCreated",
  CLEANING_STARTED: "CleaningStarted",
  CLEANING_COMPLETED: "CleaningCompleted",
  ROOM_CLEANED: "RoomCleaned",
  ROOM_CHARGE_POSTED: "RoomChargePosted",
  GUEST_FOLIO_UPDATED: "GuestFolioUpdated",
  POS_ORDER_REVIEWED: "PosOrderReviewed",
});

/** Which record an event is about (used for the event log index). */
export const EVENT_AGGREGATE = Object.freeze({
  ReservationCreated: ["RESERVATION", "reservation_id"],
  ReservationUpdated: ["RESERVATION", "reservation_id"],
  ReservationCancelled: ["RESERVATION", "reservation_id"],
  GuestCheckedIn: ["RESERVATION", "reservation_id"],
  GuestCheckedOut: ["RESERVATION", "reservation_id"],
  RoomVacated: ["ROOM", "room_id"],
  RoomStatusChanged: ["ROOM", "room_id"],
  CleaningTaskCreated: ["ROOM", "room_id"],
  CleaningStarted: ["ROOM", "room_id"],
  CleaningCompleted: ["ROOM", "room_id"],
  RoomCleaned: ["ROOM", "room_id"],
  RoomChargePosted: ["STAY", "stay_id"],
  GuestFolioUpdated: ["STAY", "stay_id"],
  PosOrderReviewed: ["POS_ORDER", "pos_order_id"],
});
