import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * BillAdjustment — composed by Bill (1 — 0..*). amount is signed: negative for
 * a discount/correction, positive for an extra charge. adjustedBy records the
 * receptionist responsible for the correction (audit trail).
 */
export const BillAdjustment = sequelize.define(
  "BillAdjustment",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    billId: { type: DataTypes.INTEGER, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    reason: { type: DataTypes.STRING(255), allowNull: false },
    adjustedBy: { type: DataTypes.INTEGER, allowNull: false },
    adjustedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "bill_adjustments", timestamps: false, indexes: [{ fields: ["bill_id"] }] }
);
