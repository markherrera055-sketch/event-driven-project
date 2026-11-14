import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const PAYMENT_STATUS = Object.freeze({ SUCCESSFUL: "SUCCESSFUL", FAILED: "FAILED" });
export const PAYMENT_METHOD = Object.freeze({ CASH: "CASH", CARD: "CARD", E_WALLET: "E_WALLET" });

/**
 * Payment — D7. Bill 1 — 0..* Payment ("paid by"); every attempt, including
 * declined ones, is recorded with an increasing attemptNo. Card / e-wallet
 * numbers are never stored — only the gateway's reference.
 */
export const Payment = sequelize.define(
  "Payment",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    billId: { type: DataTypes.INTEGER, allowNull: false },
    attemptNo: { type: DataTypes.INTEGER, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    method: { type: DataTypes.ENUM(...Object.values(PAYMENT_METHOD)), allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(PAYMENT_STATUS)), allowNull: false },
    gatewayReference: { type: DataTypes.STRING(100), allowNull: true },
    failureReason: { type: DataTypes.STRING(255), allowNull: true },
    receivedBy: { type: DataTypes.INTEGER, allowNull: false },
    processedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: "payments",
    updatedAt: false,
    indexes: [{ unique: true, fields: ["bill_id", "attempt_no"] }, { fields: ["status", "processed_at"] }],
  }
);
