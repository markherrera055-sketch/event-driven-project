import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

export const STAY_STATUS = Object.freeze({ IN_HOUSE: "IN_HOUSE", CHECKED_OUT: "CHECKED_OUT" });

/** Stay — D5. Reservation 1 — 0..1 Stay ("becomes"). */
export const Stay = sequelize.define(
  "Stay",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    reservationId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    checkInAt: { type: DataTypes.DATE, allowNull: false },
    checkOutAt: { type: DataTypes.DATE, allowNull: true },
    checkedInBy: { type: DataTypes.INTEGER, allowNull: false },
    checkedOutBy: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(STAY_STATUS)), allowNull: false, defaultValue: STAY_STATUS.IN_HOUSE },
  },
  { tableName: "stays", indexes: [{ fields: ["status"] }] }
);
