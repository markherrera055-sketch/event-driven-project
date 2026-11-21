import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const OUTBOX_STATUS = Object.freeze({ PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED", SKIPPED: "SKIPPED" });
/** Systems that receive webhooks from the PMS. */
export const OUTBOX_TARGETS = Object.freeze({ BOOKING: "BOOKING", POS: "POS", HOUSEKEEPING: "HOUSEKEEPING" });

/**
 * Transactional outbox = webhook delivery log. One row per (event, receiver),
 * written in the same DB transaction as the business change (so it is never
 * lost, nor sent for a rolled-back change) and delivered asynchronously with
 * retries. payload is the exact JSON body that is POSTed.
 */
export const IntegrationOutbox = sequelize.define(
  "IntegrationOutbox",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    integrationEventId: { type: DataTypes.INTEGER, allowNull: true },
    target: { type: DataTypes.STRING(30), allowNull: false },
    eventType: { type: DataTypes.STRING(60), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(OUTBOX_STATUS)), allowNull: false, defaultValue: OUTBOX_STATUS.PENDING },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    lastError: { type: DataTypes.STRING(500), allowNull: true },
    lastResponseStatus: { type: DataTypes.INTEGER, allowNull: true },
    // First 1000 characters of the receiver's answer (e.g. RoomCare's task id), for the admin console.
    lastResponseBody: { type: DataTypes.STRING(1000), allowNull: true },
    sentAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "integration_outbox", indexes: [{ fields: ["status", "next_attempt_at"] }] }
);
