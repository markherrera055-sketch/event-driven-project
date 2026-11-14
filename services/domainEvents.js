/**
 * Domain events raised by the core front-desk services (check-in, checkout,
 * reservation changes). The core does not know which external systems exist:
 * the integration layer registers subscriptions and turns events into outbox
 * rows written in the SAME transaction as the business change.
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
  RESERVATION_CREATED: "reservation.created",
  RESERVATION_UPDATED: "reservation.updated",
  RESERVATION_CANCELLED: "reservation.cancelled",
  RESERVATION_CHECKED_IN: "reservation.checked_in",
  RESERVATION_CHECKED_OUT: "reservation.checked_out",
  STAY_CHECKED_IN: "stay.checked_in",
  STAY_CHECKED_OUT: "stay.checked_out",
});
