import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const BILL_STATUS = Object.freeze({ DRAFT: "DRAFT", CONFIRMED: "CONFIRMED", PAID: "PAID" });

/**
 * Bill — D6. Stay 1 — 0..1 Bill ("billed as"). nightlyRate is a snapshot of
 * the room rate at the time the bill was generated. The total due is never
 * stored: it is derived by the v_bill_total view
 * (roomCharge + posted folio charges + adjustments).
 */
export const Bill = sequelize.define(
  "Bill",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    stayId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    nights: { type: DataTypes.INTEGER, allowNull: false },
    nightlyRate: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    roomCharge: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(BILL_STATUS)), allowNull: false, defaultValue: BILL_STATUS.DRAFT },
    generatedBy: { type: DataTypes.INTEGER, allowNull: false },
    generatedAt: { type: DataTypes.DATE, allowNull: false },
    confirmedAt: { type: DataTypes.DATE, allowNull: true },
    paidAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "bills", indexes: [{ fields: ["status"] }] }
);
