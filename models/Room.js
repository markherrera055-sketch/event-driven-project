import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * RoomStatus enumeration from the class diagram, extended with MAINTENANCE.
 *  - VACANT ⇄ OCCUPIED is changed only by the Room Status module
 *    (setOccupied at check-in, setVacant at checkout / room move).
 *  - VACANT ⇄ MAINTENANCE is changed only by an administrator. A room under
 *    maintenance cannot be assigned to a reservation or checked into.
 * "Reserved" and "Inactive" are deliberately NOT stored statuses: Reserved is
 * derived from reservation records (so it can never drift from them) and
 * Inactive is the isActive flag.
 */
export const ROOM_STATUS = Object.freeze({ VACANT: "VACANT", OCCUPIED: "OCCUPIED", MAINTENANCE: "MAINTENANCE" });

/** Statuses an administrator may set by hand (OCCUPIED only via check-in). */
export const ADMIN_SETTABLE_ROOM_STATUSES = [ROOM_STATUS.VACANT, ROOM_STATUS.MAINTENANCE];

/**
 * Room — D3 Rooms. isActive lets an administrator take a room out of
 * inventory without deleting its history. archivedAt marks a "deleted" room
 * that still has historical reservations (soft delete): it is hidden from
 * every list and from availability, but its reservations, stays and bills keep
 * pointing at it. Rooms without any history are deleted permanently.
 *
 * Housekeeping (light): needsCleaning is set automatically at checkout and
 * cleared by "Mark clean". It is a readiness flag, not an extra RoomStatus.
 */
export const Room = sequelize.define(
  "Room",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    roomNumber: { type: DataTypes.STRING(10), allowNull: false, unique: true },
    roomType: { type: DataTypes.STRING(50), allowNull: false },
    floor: { type: DataTypes.STRING(10), allowNull: true },
    capacity: { type: DataTypes.INTEGER, allowNull: false },
    nightlyRate: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    description: { type: DataTypes.STRING(1000), allowNull: true },
    amenities: { type: DataTypes.JSON, allowNull: true },
    status: { type: DataTypes.ENUM(...Object.values(ROOM_STATUS)), allowNull: false, defaultValue: ROOM_STATUS.VACANT },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    needsCleaning: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastCleanedAt: { type: DataTypes.DATE, allowNull: true },
    lastCleanedBy: { type: DataTypes.INTEGER, allowNull: true },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "rooms",
    indexes: [{ fields: ["room_type"] }, { fields: ["status"] }],
  }
);
