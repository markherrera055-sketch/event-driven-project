import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * RoomType — the catalogue of room types, so external systems (the Guest
 * Booking System) can refer to a type by a stable numeric id (room_type_id).
 * rooms.room_type references room_types.name (ON UPDATE CASCADE), which keeps
 * every existing screen and query that works with the type name unchanged.
 * Rates and capacity stay on the rooms themselves.
 */
export const RoomType = sequelize.define(
  "RoomType",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(50), allowNull: false, unique: true },
    description: { type: DataTypes.STRING(255), allowNull: true },
  },
  { tableName: "room_types" }
);
