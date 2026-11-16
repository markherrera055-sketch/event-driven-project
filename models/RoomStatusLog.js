import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** Who/what caused a room status change. */
export const STATUS_CHANGE_SOURCE = Object.freeze({
  FRONT_DESK: "FRONT_DESK",
  ADMIN: "ADMIN",
  BOOKING: "BOOKING",
  HOUSEKEEPING: "HOUSEKEEPING",
  SYSTEM: "SYSTEM",
});

/**
 * Audit trail of every room status transition (append-only). Written in the
 * same transaction as the change by services/roomStatusService.js.
 * reference holds an external id when one exists (e.g. housekeeping task id).
 */
export const RoomStatusLog = sequelize.define(
  "RoomStatusLog",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roomId: { type: DataTypes.INTEGER, allowNull: false },
    fromStatus: { type: DataTypes.STRING(20), allowNull: true },
    toStatus: { type: DataTypes.STRING(20), allowNull: false },
    reason: { type: DataTypes.STRING(40), allowNull: false },
    source: { type: DataTypes.STRING(30), allowNull: false },
    actorUserId: { type: DataTypes.INTEGER, allowNull: true },
    reference: { type: DataTypes.STRING(100), allowNull: true },
    changedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "room_status_logs", timestamps: false, indexes: [{ fields: ["room_id", "changed_at"] }] }
);
