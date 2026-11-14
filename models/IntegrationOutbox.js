import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const OUTBOX_STATUS = Object.freeze({ PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED", SKIPPED: "SKIPPED" });
export const OUTBOX_TARGETS = Object.freeze({ POS: "POS", RESERVATIONS: "RESERVATIONS" });

/**
 * Transactional outbox for outbound webhooks. Events are written in the same
 * DB transaction as the business change (so they are never lost or sent for a
 * rolled-back change) and delivered asynchronously with retries.
 */
export const IntegrationOutbox = sequelize.define(
  "IntegrationOutbox",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    target: { type: DataTypes.ENUM(...Object.values(OUTBOX_TARGETS)), allowNull: false },
    eventType: { type: DataTypes.STRING(60), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(OUTBOX_STATUS)), allowNull: false, defaultValue: OUTBOX_STATUS.PENDING },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lastError: { type: DataTypes.STRING(500), allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "integration_outbox", indexes: [{ fields: ["status", "next_attempt_at"] }] }
);
