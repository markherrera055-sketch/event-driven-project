/**
 * Which domain events are forwarded to which external system.
 *  - Hotel Reservation System: lifecycle of reservations that IT created
 *    (so it can show "checked in / checked out / cancelled" to the customer).
 *  - POS: in-house guest changes, so the POS knows which rooms can be charged.
 * Payloads contain references and statuses only — no contact details or ID data.
 */
import { subscribe, EVENTS } from "../../services/domainEvents.js";
import { OUTBOX_TARGETS, RESERVATION_SOURCE } from "../../models/index.js";
import { enqueue } from "./outbox.js";

const RESERVATION_SYSTEM_EVENTS = new Set([
  EVENTS.RESERVATION_UPDATED,
  EVENTS.RESERVATION_CANCELLED,
  EVENTS.RESERVATION_CHECKED_IN,
  EVENTS.RESERVATION_CHECKED_OUT,
]);
const POS_EVENTS = new Set([EVENTS.STAY_CHECKED_IN, EVENTS.STAY_CHECKED_OUT]);

let registered = false;
export function registerIntegrationSubscriptions() {
  if (registered) return;
  registered = true;
  subscribe(async (eventType, payload, { transaction }) => {
    if (
      RESERVATION_SYSTEM_EVENTS.has(eventType) &&
      payload.source === RESERVATION_SOURCE.RESERVATION_SYSTEM &&
      payload.origin !== "RESERVATION_SYSTEM" // never echo a change back to the system that made it
    ) {
      await enqueue(OUTBOX_TARGETS.RESERVATIONS, eventType, payload, transaction);
    }
    if (POS_EVENTS.has(eventType)) {
      await enqueue(OUTBOX_TARGETS.POS, eventType, payload, transaction);
    }
  });
}
