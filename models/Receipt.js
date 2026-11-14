import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** Receipt — Payment 1 — 0..1 Receipt ("issues"); only for successful payments. */
export const Receipt = sequelize.define(
  "Receipt",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    paymentId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    receiptNo: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    issuedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: "receipts", timestamps: false }
);
