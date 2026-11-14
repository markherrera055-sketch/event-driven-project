import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const CHARGE_CATEGORIES = Object.freeze(["FOOD", "BEVERAGE", "MINIBAR", "LAUNDRY", "SPA", "SERVICE", "OTHER"]);

/**
 * StayCharge — the guest folio. Charges posted to a room by an external system
 * (the POS) during a stay. Charges are added to the final bill through
 * the v_bill_total view. Corrections are made with a bill adjustment (7.0). (sourceSystem, externalTransactionId) is unique, so the
 * same POS transaction can never be charged twice.
 */
export const StayCharge = sequelize.define(
  "StayCharge",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    stayId: { type: DataTypes.INTEGER, allowNull: false },
    sourceSystem: { type: DataTypes.STRING(30), allowNull: false },
    externalTransactionId: { type: DataTypes.STRING(100), allowNull: false },
    outlet: { type: DataTypes.STRING(80), allowNull: true },
    category: { type: DataTypes.ENUM(...CHARGE_CATEGORIES), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    items: { type: DataTypes.JSON, allowNull: true },
    transactionAt: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: "stay_charges",
    indexes: [
      { unique: true, fields: ["source_system", "external_transaction_id"], name: "uq_charge_external" },
      { fields: ["stay_id"] },
    ],
  }
);
