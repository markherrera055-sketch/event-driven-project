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
 * Every transition is a conditional UPDATE on the locked row (… WHERE status =
 * <expected>), is written to room_status_logs and raises RoomStatusChanged, all
 * inside the caller's transaction.
 */
import { Room, Reservation, RoomStatusLog, ROOM_STATUS, READY_ROOM_STATUSES, RESERVATION_STATUS } from "../models/index.js";
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

  const now = new Date();
  const [count] = await Room.update({ status: to, statusChangedAt: now }, { where: { id: room.id, status: from }, transaction });
  if (count !== 1) throw conflict("ROOM_STATUS_CHANGED", `Room ${room.roomNumber} was changed by someone else. Reload and try again.`);
  room.setDataValue("status", to);
  room.setDataValue("statusChangedAt", now);

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
