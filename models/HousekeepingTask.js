import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const HOUSEKEEPING_TASK_STATUS = Object.freeze({
  OPEN: "OPEN", // task created in the Housekeeping System, cleaning not started yet
  IN_PROGRESS: "IN_PROGRESS", // CleaningStarted received (room CLEANING)
  COMPLETED: "COMPLETED", // CleaningCompleted received (room ready)
  SUPERSEDED: "SUPERSEDED", // the front desk marked the room clean manually before housekeeping reported back
});

/**
 * Reference to a cleaning task that lives in the external Housekeeping System.
 * The PMS does NOT manage cleaning staff, schedules or progress — it only keeps
 * the external task id, the room it concerns, and the start / completion facts
 * that drive the room status. externalTaskId is unique, which is what makes a
 * repeated "cleaning completed" for the same task impossible to apply twice.
 * startedBy / completedBy are the Housekeeping System's own employee ids.
 */
export const HousekeepingTask = sequelize.define(
  "HousekeepingTask",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    externalTaskId: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    roomId: { type: DataTypes.INTEGER, allowNull: false },
    stayId: { type: DataTypes.INTEGER, allowNull: true },
    sourceEventId: { type: DataTypes.STRING(30), allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(HOUSEKEEPING_TASK_STATUS)), allowNull: false },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    startedBy: { type: DataTypes.STRING(60), allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    completedBy: { type: DataTypes.STRING(60), allowNull: true },
    remarks: { type: DataTypes.STRING(500), allowNull: true },
  },
  { tableName: "housekeeping_tasks", indexes: [{ fields: ["room_id", "status"] }, { fields: ["completed_at"] }] }
);
