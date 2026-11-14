import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const INTEGRATION_SOURCES = Object.freeze({ POS: "POS", RESERVATIONS: "RESERVATIONS" });

/**
 * Log of inbound integration requests, keyed by (source, idempotencyKey).
 * Used to (a) replay the original response when a client retries the same
 * request and (b) audit what external systems sent. responseStatus is NULL
 * while the request is still being processed.
 */
export const IntegrationRequest = sequelize.define(
  "IntegrationRequest",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    source: { type: DataTypes.ENUM(...Object.values(INTEGRATION_SOURCES)), allowNull: false },
    idempotencyKey: { type: DataTypes.STRING(100), allowNull: false },
    method: { type: DataTypes.STRING(10), allowNull: false },
    path: { type: DataTypes.STRING(255), allowNull: false },
    requestHash: { type: DataTypes.CHAR(64), allowNull: false },
    responseStatus: { type: DataTypes.INTEGER, allowNull: true },
    responseBody: { type: DataTypes.JSON, allowNull: true },
  },
  {
    tableName: "integration_requests",
    indexes: [
      { unique: true, fields: ["source", "idempotency_key"], name: "uq_integration_idempotency" },
      { fields: ["created_at"] },
    ],
  }
);
