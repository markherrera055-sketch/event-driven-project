/**
 * Event publishing: domain event → integration_events (log, public event_id)
 * → one integration_outbox row per subscribed system — all inside the
 * transaction of the business change.
 *
 * Default subscriptions (override per system with <SYSTEM>_WEBHOOK_EVENTS):
 *   BOOKING       reservation lifecycle of bookings IT created — never an echo of its own change
 *   POS           GuestCheckedIn / GuestCheckedOut (which rooms can be charged),
 *                 PosOrderReviewed (a purchase notification was added to the folio or rejected)
 *   HOUSEKEEPING  RoomVacated (create a cleaning task), RoomStatusChanged, RoomCleaned
 *   HR            none — HR pulls verified housekeeping task records (see integrations/hr)
 * A system only gets webhooks when its <SYSTEM>_WEBHOOK_URL is configured;
 * the event is still recorded in integration_events either way.
 *
 * Webhook body (flat, like the published examples):
 *   { "event": "RoomVacated", "event_id": "EVT-000042", "occurred_at": "…", …payload fields }
 * A receiver may get extra fields of its own (`enrich`): Housekeeping receives
 * `roomcare_room_id` (RoomCare's id for the room, once room sync has mapped it) on
 * RoomVacated, RoomStatusChanged and RoomCleaned. That RoomCare is the Housekeeping
 * System is an UNVERIFIED ASSUMPTION pending Member 3's confirmation.
 */
import crypto from "crypto";
import { subscribe, EVENTS, EVENT_AGGREGATE } from "../../services/domainEvents.js";
import { IntegrationEvent, IntegrationOutbox, ExternalRoomMapping, EXTERNAL_SYSTEMS, OUTBOX_STATUS, OUTBOX_TARGETS } from "../../models/index.js";
import { clientSettings } from "./clients.js";

export const DEFAULT_SUBSCRIPTIONS = Object.freeze({
  [OUTBOX_TARGETS.BOOKING]: {
    events: [EVENTS.RESERVATION_UPDATED, EVENTS.RESERVATION_CANCELLED, EVENTS.GUEST_CHECKED_IN, EVENTS.GUEST_CHECKED_OUT],
    // Only bookings that came from the Booking System, and not changes it made itself.
    filter: (payload) => payload.source === "BOOKING" && payload.origin !== "BOOKING",
  },
  [OUTBOX_TARGETS.POS]: { events: [EVENTS.GUEST_CHECKED_IN, EVENTS.GUEST_CHECKED_OUT, EVENTS.POS_ORDER_REVIEWED] },
  [OUTBOX_TARGETS.HOUSEKEEPING]: {
    events: [EVENTS.ROOM_VACATED, EVENTS.ROOM_STATUS_CHANGED, EVENTS.ROOM_CLEANED],
    enrich: async (body, transaction) => {
      if (!body.room_id) return body;
      const mapping = await ExternalRoomMapping.findOne({ where: { sourceSystem: EXTERNAL_SYSTEMS.ROOMCARE, roomId: body.room_id }, attributes: ["externalRoomId"], transaction });
      return { ...body, roomcare_room_id: mapping?.externalRoomId ?? null };
    },
  },
});

export const subscribedEvents = (target) => {
  const override = clientSettings(target).webhookEvents;
  return override?.length ? override : DEFAULT_SUBSCRIPTIONS[target]?.events || [];
};

const receivers = (eventType, payload) =>
  Object.keys(DEFAULT_SUBSCRIPTIONS).filter((target) => {
    if (!clientSettings(target).webhookUrl) return false;
    if (!subscribedEvents(target).includes(eventType)) return false;
    const { filter } = DEFAULT_SUBSCRIPTIONS[target];
    return !filter || filter(payload);
  });

/** Records the event and queues a webhook per receiver. Returns the event row. */
export async function publishEvent(eventType, payload, transaction) {
  const occurredAt = new Date();
  const [aggregateType, idField] = EVENT_AGGREGATE[eventType] || [null, null];
  const event = await IntegrationEvent.create(
    {
      eventId: `TMP-${crypto.randomUUID()}`.slice(0, 30),
      eventType,
      aggregateType,
      aggregateId: idField ? payload[idField] ?? null : null,
      payload,
      occurredAt,
    },
    { transaction }
  );
  const eventId = `EVT-${String(event.id).padStart(6, "0")}`;
  await event.update({ eventId }, { transaction });

  const body = { event: eventType, event_id: eventId, occurred_at: occurredAt.toISOString(), ...payload };
  for (const target of receivers(eventType, payload)) {
    const { enrich } = DEFAULT_SUBSCRIPTIONS[target];
    await IntegrationOutbox.create(
      { integrationEventId: event.id, target, eventType, payload: enrich ? await enrich(body, transaction) : body, status: OUTBOX_STATUS.PENDING, nextAttemptAt: occurredAt },
      { transaction }
    );
  }
  return event;
}

let registered = false;
export function registerIntegrationSubscriptions() {
  if (registered) return;
  registered = true;
  subscribe((eventType, payload, { transaction }) => publishEvent(eventType, payload, transaction));
}
