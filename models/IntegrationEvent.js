import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * Integration event log: every business event the PMS publishes
 * (GuestCheckedIn, RoomVacated, …), written in the same transaction as the
 * change that caused it. eventId (EVT-000001) is the public, stable id that
 * every receiver sees; one event can be delivered to several systems (one
 * integration_outbox row per receiver), all sharing this eventId so receivers
 * can de-duplicate.
 */
export const IntegrationEvent = sequelize.define(
  "IntegrationEvent",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    eventId: { type: DataTypes.STRING(30), allowNull: false, unique: true },
    eventType: { type: DataTypes.STRING(60), allowNull: false },
    aggregateType: { type: DataTypes.STRING(30), allowNull: true },
    aggregateId: { type: DataTypes.INTEGER, allowNull: true },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurredAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: "integration_events",
    updatedAt: false,
    indexes: [{ fields: ["event_type", "occurred_at"] }, { fields: ["aggregate_type", "aggregate_id"] }],
  }
);
