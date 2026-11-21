import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * Room catalogue synchronisation (Frontdesk → OnlineBooking / RoomCare).
 *
 *   PENDING  waiting to be sent (or waiting for its next retry)
 *   SYNCED   the receiving system accepted the room's latest state
 *   FAILED   refused by the receiver (4xx) or retries exhausted; an admin can retry
 *   BLOCKED  nothing was sent: the receiver's API contract is not implemented in
 *            the Frontdesk yet (integrations/roomSync/adapters.js), or the target
 *            is not configured. Re-queued automatically once the adapter is ready.
 *   SUPERSEDED  replaced by a newer job for the same room and system (history only)
 *
 * Invariant: at most one PENDING / BLOCKED / FAILED job per (room, target).
 */
export const ROOM_SYNC_STATUS = Object.freeze({ PENDING: "PENDING", SYNCED: "SYNCED", FAILED: "FAILED", BLOCKED: "BLOCKED", SUPERSEDED: "SUPERSEDED" });
export const OPEN_ROOM_SYNC_STATUSES = Object.freeze([ROOM_SYNC_STATUS.PENDING, ROOM_SYNC_STATUS.BLOCKED, ROOM_SYNC_STATUS.FAILED]);

/** Systems that receive the Frontdesk room catalogue. */
export const ROOM_SYNC_TARGETS = Object.freeze({ STAYBOOK: "STAYBOOK", ROOMCARE: "ROOMCARE" });

/**
 * One row = "bring <target>'s copy of room <roomId> up to date". It carries no
 * room data: the room's CURRENT state is read when the job is sent, so several
 * edits made before delivery collapse into one request (the open job is
 * re-used and its `version` bumped). Written in the same transaction as the
 * room change, so a room change is never lost and never synced if rolled back.
 *
 * operation UPSERT creates the external room when no mapping exists yet
 * (external_room_mappings), otherwise updates the mapped record.
 * operation DEACTIVATE is used for rooms deleted (archived) in the Frontdesk:
 * external records are never deleted (see docs/ROOM_SYNC.md).
 *
 * room_id has no foreign key on purpose: the job history must survive even if
 * a never-synced room is removed. idempotency_key is stable for the
 * (room, target, operation, generation) so retries of a create can be
 * de-duplicated by the receiver.
 */
export const RoomSyncJob = sequelize.define(
  "RoomSyncJob",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roomId: { type: DataTypes.INTEGER, allowNull: false },
    roomNumber: { type: DataTypes.STRING(10), allowNull: false },
    target: { type: DataTypes.STRING(30), allowNull: false },
    operation: { type: DataTypes.STRING(20), allowNull: false },
    trigger: { type: DataTypes.STRING(200), allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(ROOM_SYNC_STATUS)), allowNull: false, defaultValue: ROOM_SYNC_STATUS.PENDING },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    // Set while a worker is sending this job; no other worker may claim it until then.
    lockedUntil: { type: DataTypes.DATE, allowNull: true },
    idempotencyKey: { type: DataTypes.STRING(100), allowNull: false },
    externalRoomId: { type: DataTypes.STRING(50), allowNull: true },
    lastError: { type: DataTypes.STRING(500), allowNull: true },
    lastResponseStatus: { type: DataTypes.INTEGER, allowNull: true },
    lastResponseBody: { type: DataTypes.STRING(1000), allowNull: true },
    lastAttemptAt: { type: DataTypes.DATE, allowNull: true },
    syncedAt: { type: DataTypes.DATE, allowNull: true },
    requestedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "room_sync_jobs",
    indexes: [{ fields: ["status", "next_attempt_at"] }, { fields: ["room_id", "target", "status"] }, { fields: ["target", "synced_at"] }],
  }
);
