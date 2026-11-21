/**
 * Cleaning notification history for the Admin Console: every RoomVacated
 * event (checkout / room move), its webhook delivery to Housekeeping / RoomCare
 * (status, attempts, HTTP answer) and the cleaning task RoomCare reported back
 * (PENDING → IN_PROGRESS → COMPLETED), plus the room's current status.
 *
 * UNVERIFIED ASSUMPTION: RoomCare is the Housekeeping System (Member 3), so
 * "delivery to RoomCare" here means delivery to the HOUSEKEEPING webhook target.
 * Member 3 has not confirmed this yet.
 */
import {
  IntegrationEvent,
  IntegrationOutbox,
  HousekeepingTask,
  ExternalRoomMapping,
  Room,
  EXTERNAL_SYSTEMS,
  OUTBOX_TARGETS,
  HOUSEKEEPING_TASK_STATUS,
  occupancyStatusOf,
} from "../../models/index.js";
import { EVENTS } from "../../services/domainEvents.js";

/** Housekeeping task status → the PENDING / IN_PROGRESS / COMPLETED vocabulary used with RoomCare. */
export const cleaningStatusOf = (task) =>
  !task
    ? "PENDING"
    : {
        [HOUSEKEEPING_TASK_STATUS.OPEN]: "PENDING",
        [HOUSEKEEPING_TASK_STATUS.IN_PROGRESS]: "IN_PROGRESS",
        [HOUSEKEEPING_TASK_STATUS.COMPLETED]: "COMPLETED",
        [HOUSEKEEPING_TASK_STATUS.SUPERSEDED]: "COMPLETED_AT_FRONT_DESK",
      }[task.status];

export async function cleaningNotifications({ limit = 50 } = {}) {
  const events = await IntegrationEvent.findAll({ where: { eventType: EVENTS.ROOM_VACATED }, order: [["id", "DESC"]], limit });
  if (!events.length) return [];
  const roomIds = [...new Set(events.map((e) => e.aggregateId).filter(Boolean))];
  const [deliveries, tasks, mappings, rooms] = await Promise.all([
    IntegrationOutbox.findAll({ where: { integrationEventId: events.map((e) => e.id), target: OUTBOX_TARGETS.HOUSEKEEPING } }),
    HousekeepingTask.findAll({ where: { sourceEventId: events.map((e) => e.eventId) } }),
    ExternalRoomMapping.findAll({ where: { sourceSystem: EXTERNAL_SYSTEMS.ROOMCARE, roomId: roomIds } }),
    Room.findAll({ where: { id: roomIds }, attributes: ["id", "roomNumber", "status", "lastCleanedAt"] }),
  ]);
  const deliveryOf = new Map(deliveries.map((d) => [d.integrationEventId, d]));
  const taskOf = new Map(tasks.map((t) => [t.sourceEventId, t]));
  const mappingOf = new Map(mappings.map((m) => [m.roomId, m.externalRoomId]));
  const roomOf = new Map(rooms.map((r) => [r.id, r]));

  return events.map((e) => {
    const d = deliveryOf.get(e.id);
    const t = taskOf.get(e.eventId);
    const room = roomOf.get(e.aggregateId);
    return {
      eventId: e.eventId,
      occurredAt: e.occurredAt,
      reason: e.payload?.reason ?? null,
      reservationCode: e.payload?.reservation_code ?? null,
      roomId: e.aggregateId,
      roomNumber: e.payload?.room_number ?? room?.roomNumber ?? null,
      roomcareRoomId: mappingOf.get(e.aggregateId) ?? null,
      checkoutTime: e.payload?.checkout_time ?? null,
      message: e.payload?.message ?? null,
      delivery: d
        ? {
            id: d.id,
            status: d.status,
            attempts: d.attempts,
            lastError: d.lastError,
            lastResponseStatus: d.lastResponseStatus,
            lastResponseBody: d.lastResponseBody,
            sentAt: d.sentAt,
          }
        : null,
      cleaningStatus: cleaningStatusOf(t),
      task: t ? { externalTaskId: t.externalTaskId, status: t.status, startedAt: t.startedAt, completedAt: t.completedAt, completedBy: t.completedBy } : null,
      roomStatus: room?.status ?? null,
      occupancyStatus: room ? occupancyStatusOf(room.status) : null,
      lastCleanedAt: room?.lastCleanedAt ?? null,
    };
  });
}
