import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** External systems whose room ids are mapped onto PMS rooms. */
export const EXTERNAL_SYSTEMS = Object.freeze({ STAYBOOK: "STAYBOOK" });

/**
 * ExternalRoomMapping — explicit link between a room id in another system
 * (e.g. StayBook's rooms.id) and a PMS room. The two systems number their
 * rooms independently, so nothing is matched by guesswork: an administrator
 * maintains these rows (Admin Console → Integrations).
 *
 * One external room ↔ one PMS room per system (both directions unique), so a
 * PMS room can always be translated back to the external room id.
 */
export const ExternalRoomMapping = sequelize.define(
  "ExternalRoomMapping",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    sourceSystem: { type: DataTypes.STRING(30), allowNull: false },
    externalRoomId: { type: DataTypes.STRING(50), allowNull: false },
    roomId: { type: DataTypes.INTEGER, allowNull: false },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    tableName: "external_room_mappings",
    indexes: [
      { unique: true, fields: ["source_system", "external_room_id"], name: "uq_external_room" },
      { unique: true, fields: ["source_system", "room_id"], name: "uq_external_room_pms_room" },
    ],
  }
);
