import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** Server-side login sessions (replaces the in-memory store, which leaks and is lost on restart). */
export const Session = sequelize.define(
  "Session",
  {
    sid: { type: DataTypes.STRING(128), primaryKey: true },
    expires: { type: DataTypes.DATE, allowNull: false },
    data: { type: DataTypes.TEXT, allowNull: false },
  },
  { tableName: "sessions", indexes: [{ fields: ["expires"] }] }
);
