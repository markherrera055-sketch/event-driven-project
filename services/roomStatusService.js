/**
 * Room Status module — the ONLY place that changes rooms.status.
 *
 * Allowed transitions (anything else is refused with 409 INVALID_ROOM_STATUS_TRANSITION):
 *
 *   AVAILABLE   → RESERVED (reservation assigned), OCCUPIED (check-in / room move), MAINTENANCE
 *   RESERVED    → AVAILABLE (last assigned reservation released), OCCUPIED, MAINTENANCE
 *   OCCUPIED    → DIRTY (checkout / room move)
 *   DIRTY       → CLEANING (housekeeping starts), MAINTENANCE
 *   CLEANING    → AVAILABLE | RESERVED (cleaning completed), DIRTY (re-clean), MAINTENANCE
 *   MAINTENANCE → AVAILABLE | RESERVED (back in service, ready), DIRTY (back in service, needs cleaning)
 *
 * "Ready" (after cleaning or maintenance) resolves to RESERVED when a CONFIRMED
 * reservation is assigned to the room, otherwise AVAILABLE.
 *
 * Cleaning guard: rooms.cleaning_required is set whenever a room becomes DIRTY /
 * CLEANING (or goes into MAINTENANCE from them) and is kept through MAINTENANCE.
 * A room only becomes ready (AVAILABLE / RESERVED) from a non-ready status when
 * no cleaning is pending (flag clear AND no open housekeeping task), unless the
 * change IS the cleaning: a verified housekeeping completion (CLEANING_COMPLETED)
 * or the front desk's "Mark clean" (MANUAL_CLEAN). Otherwise 409 ROOM_NEEDS_CLEANING.
 * So DIRTY → MAINTENANCE → AVAILABLE is refused; the room returns as DIRTY, or
 * the cleaning is recorded while it is under maintenance (finishCleaning).
 *
 * Every transition is a conditional UPDATE on the locked row (… WHERE status =
 * <expected>), is written to room_status_logs and raises RoomStatusChanged, all
 * inside the caller's transaction.
 */
import {
  Room,
  Reservation,
  RoomStatusLog,
  HousekeepingTask,
  ROOM_STATUS,
  READY_ROOM_STATUSES,
  HOUSEKEEPING_ROOM_STATUSES,
  HOUSEKEEPING_TASK_STATUS,
  RESERVATION_STATUS,
} from "../models/index.js";
import { AppError, conflict, notFound } from "../utils/errors.js";
import { emit, EVENTS } from "./domainEvents.js";
import { roomStatusChangedData } from "./eventPayloads.js";

const S = ROOM_STATUS;

export const ROOM_TRANSITIONS = Object.freeze({
  [S.AVAILABLE]: [S.RESERVED, S.OCCUPIED, S.MAINTENANCE],
  [S.RESERVED]: [S.AVAILABLE, S.OCCUPIED, S.MAINTENANCE],
  [S.OCCUPIED]: [S.DIRTY],
  [S.DIRTY]: [S.CLEANING, S.MAINTENANCE],
  [S.CLEANING]: [S.AVAILABLE, S.RESERVED, S.DIRTY, S.MAINTENANCE],
  [S.MAINTENANCE]: [S.AVAILABLE, S.RESERVED, S.DIRTY],
});

export const canTransition = (from, to) => (ROOM_TRANSITIONS[from] || []).includes(to);

export const STATUS_REASON = Object.freeze({
  RESERVATION_ASSIGNED: "RESERVATION_ASSIGNED",
  RESERVATION_RELEASED: "RESERVATION_RELEASED",
  CHECK_IN: "CHECK_IN",
  CHECKOUT: "CHECKOUT",
  ROOM_MOVE_IN: "ROOM_MOVE_IN",
  ROOM_MOVE_OUT: "ROOM_MOVE_OUT",
  CLEANING_STARTED: "CLEANING_STARTED",
  CLEANING_COMPLETED: "CLEANING_COMPLETED",
  MANUAL_CLEAN: "MANUAL_CLEAN",
  MAINTENANCE_STARTED: "MAINTENANCE_STARTED",
  MAINTENANCE_ENDED: "MAINTENANCE_ENDED",
});

/** The only reasons that may make a room ready while cleaning is pending: the cleaning itself. */
const CLEANING_REASONS = Object.freeze([STATUS_REASON.CLEANING_COMPLETED, STATUS_REASON.MANUAL_CLEAN]);

const OPEN_TASK_STATUSES = [HOUSEKEEPING_TASK_STATUS.OPEN, HOUSEKEEPING_TASK_STATUS.IN_PROGRESS];

/**
 * Whether the room still has to be cleaned: it is DIRTY / CLEANING, its
 * cleaning_required flag is set (e.g. it went into maintenance dirty), or a
 * housekeeping task for it is still open. Returns { required, openTask }.
 */
export async function pendingCleaning(room, transaction) {
  const openTask = await HousekeepingTask.findOne({
    where: { roomId: room.id, status: OPEN_TASK_STATUSES },
    attributes: ["id", "externalTaskId", "status"],
    transaction,
  });
  const required = HOUSEKEEPING_ROOM_STATUSES.includes(room.status) || !!room.cleaningRequired || !!openTask;
  return { required, openTask };
}

const needsCleaningError = (room, to, openTask) => {
  const why = openTask
    ? `cleaning task ${openTask.externalTaskId} is still ${openTask.status}`
    : room.status === S.MAINTENANCE
      ? "it went into maintenance before it was cleaned"
      : `it is ${room.status}`;
  return conflict(
    "ROOM_NEEDS_CLEANING",
    `Room ${room.roomNumber} cannot become ${to}: ${why}. It becomes ready only when housekeeping reports the cleaning completed or the front desk uses "Mark clean"` +
      (room.status === S.MAINTENANCE ? `; to end maintenance now, return it to service as "Needs cleaning" (DIRTY).` : "."),
    { room_status: room.status, cleaning_required: true, open_task: openTask ? { external_task_id: openTask.externalTaskId, task_status: openTask.status } : null }
  );
};

export const invalidTransition = (room, from, to) =>
  new AppError(409, "INVALID_ROOM_STATUS_TRANSITION", `Room ${room.roomNumber} cannot change from ${from} to ${to}.`, {
    from,
    to,
    allowed: ROOM_TRANSITIONS[from] || [],
  });

/** SELECT … FOR UPDATE on one room. */
export async function lockRoomRow(roomId, transaction) {
  const room = await Room.findByPk(roomId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!room) throw notFound("Room");
  return room;
}

/** Status a clean, in-service room should have: RESERVED if a confirmed reservation is assigned, else AVAILABLE. */
export async function readyStatusFor(roomId, transaction) {
  const assigned = await Reservation.count({ where: { roomId, status: RESERVATION_STATUS.CONFIRMED }, transaction });
  return assigned > 0 ? S.RESERVED : S.AVAILABLE;
}

/**
 * Changes a room's status. `room` must be a row locked by the caller in this
 * transaction (or an id, which is then locked here).
 * ctx: { reason, source, actor?, reference? }. Returns the room (updated).
 */
export async function transition(room, to, ctx, transaction) {
  if (typeof room === "number") room = await lockRoomRow(room, transaction);
  const from = room.status;
  if (from === to) return room;
  if (!canTransition(from, to)) throw invalidTransition(room, from, to);

  const becomingReady = READY_ROOM_STATUSES.includes(to) && !READY_ROOM_STATUSES.includes(from);
  const isCleaning = CLEANING_REASONS.includes(ctx.reason);
  if (becomingReady && !isCleaning) {
    const { required, openTask } = await pendingCleaning(room, transaction);
    if (required) throw needsCleaningError(room, to, openTask);
  }

  const now = new Date();
  const values = { status: to, statusChangedAt: now };
  if (HOUSEKEEPING_ROOM_STATUSES.includes(to) || (to === S.MAINTENANCE && HOUSEKEEPING_ROOM_STATUSES.includes(from))) {
    values.cleaningRequired = true; // vacated, or taken out of service before it was cleaned
  } else if (becomingReady && isCleaning) {
    values.cleaningRequired = false;
  }
  const [count] = await Room.update(values, { where: { id: room.id, status: from }, transaction });
  if (count !== 1) throw conflict("ROOM_STATUS_CHANGED", `Room ${room.roomNumber} was changed by someone else. Reload and try again.`);
  for (const [key, value] of Object.entries(values)) room.setDataValue(key, value);

  await RoomStatusLog.create(
    {
      roomId: room.id,
      fromStatus: from,
      toStatus: to,
      reason: ctx.reason,
      source: ctx.source,
      actorUserId: ctx.actor?.id ?? null,
      reference: ctx.reference ?? null,
      changedAt: now,
    },
    { transaction }
  );
  await emit(EVENTS.ROOM_STATUS_CHANGED, roomStatusChangedData(room, from, to, ctx), { transaction });
  return room;
}

/**
 * Keeps AVAILABLE ⇄ RESERVED in line with the room's assigned confirmed
 * reservations. Rooms in any other status (occupied, dirty, cleaning,
 * maintenance) are left alone: they become RESERVED or AVAILABLE when they are
 * next made ready.
 */
export async function syncReservedStatus(roomId, ctx, transaction) {
  if (!roomId) return null;
  const room = await lockRoomRow(roomId, transaction);
  if (!READY_ROOM_STATUSES.includes(room.status)) return room;
  const target = await readyStatusFor(room.id, transaction);
  if (target === room.status) return room;
  return transition(
    room,
    target,
    { ...ctx, reason: target === S.RESERVED ? STATUS_REASON.RESERVATION_ASSIGNED : STATUS_REASON.RESERVATION_RELEASED },
    transaction
  );
}

/**
 * Cleaning finished: DIRTY → CLEANING → ready, or CLEANING → ready. A room
 * reported clean while still DIRTY passes through CLEANING so every logged step
 * is a valid transition.
 */
export async function makeReadyAfterCleaning(room, ctx, transaction) {
  if (room.status === S.DIRTY) {
    await transition(room, S.CLEANING, { ...ctx, reason: STATUS_REASON.CLEANING_STARTED }, transaction);
  }
  if (room.status !== S.CLEANING) throw invalidTransition(room, room.status, S.AVAILABLE);
  return transition(room, await readyStatusFor(room.id, transaction), ctx, transaction);
}

/**
 * A verified cleaning (housekeeping completion or front-desk "Mark clean").
 * DIRTY / CLEANING rooms become ready (makeReadyAfterCleaning). A room under
 * MAINTENANCE that still needed cleaning stays out of service; only its
 * cleaning requirement is cleared, so ending maintenance can then make it ready.
 * The caller has checked that cleaning was pending (pendingCleaning).
 */
export async function finishCleaning(room, ctx, transaction) {
  if (room.status !== S.MAINTENANCE) return makeReadyAfterCleaning(room, ctx, transaction);
  await Room.update({ cleaningRequired: false }, { where: { id: room.id }, transaction });
  room.setDataValue("cleaningRequired", false);
  return room;
}

export async function statusHistory(roomId, { limit = 50 } = {}) {
  const room = await Room.findByPk(roomId, { attributes: ["id"] });
  if (!room) throw notFound("Room");
  const rows = await RoomStatusLog.findAll({
    where: { roomId },
    include: [{ association: "actor", attributes: ["id", "fullName", "role"] }],
    order: [["id", "DESC"]],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    reason: r.reason,
    source: r.source,
    reference: r.reference,
    actor: r.actor ? { id: r.actor.id, fullName: r.actor.fullName, role: r.actor.role } : null,
    changedAt: r.changedAt,
  }));
}
