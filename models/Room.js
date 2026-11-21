import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * Room status lifecycle (see services/roomStatusService.js for the transition
 * rules — status is never written directly by other code):
 *
 *   AVAILABLE ──assign confirmed reservation──► RESERVED
 *   AVAILABLE / RESERVED ──check-in──► OCCUPIED ──checkout / room move──► DIRTY
 *   DIRTY ──housekeeping starts──► CLEANING ──housekeeping completes──► AVAILABLE
 *                                   (or RESERVED when a confirmed reservation is still assigned)
 *   any state except OCCUPIED ──► MAINTENANCE ──back in service──► AVAILABLE / RESERVED, or DIRTY
 *
 * RESERVED means "a confirmed reservation is assigned to this room". Whether a
 * room can be booked for particular dates is ALWAYS decided from reservation
 * dates (availabilityService), never from this status alone.
 * "Inactive" and "Deleted" are not statuses: they are the isActive flag and
 * archivedAt.
 */
export const ROOM_STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  OCCUPIED: "OCCUPIED",
  DIRTY: "DIRTY",
  CLEANING: "CLEANING",
  MAINTENANCE: "MAINTENANCE",
});

/** Physically ready for a guest (clean, not in use, not under maintenance). */
export const READY_ROOM_STATUSES = Object.freeze([ROOM_STATUS.AVAILABLE, ROOM_STATUS.RESERVED]);
/** Waiting for, or in, housekeeping. */
export const HOUSEKEEPING_ROOM_STATUSES = Object.freeze([ROOM_STATUS.DIRTY, ROOM_STATUS.CLEANING]);

/**
 * Housekeeping-style view of a room status, for external systems that speak in
 * those terms (OnlineBooking / RoomCare room sync, docs/ROOM_SYNC.md §5):
 *   AVAILABLE, RESERVED → VACANT_CLEAN   (ready for the next guest)
 *   DIRTY, CLEANING     → VACANT_DIRTY   (checked out, cleaning not confirmed yet)
 *   OCCUPIED            → OCCUPIED
 *   MAINTENANCE         → OUT_OF_ORDER
 * The stored status stays the source of truth; this is a derived label only.
 */
export const OCCUPANCY_STATUS = Object.freeze({ VACANT_CLEAN: "VACANT_CLEAN", VACANT_DIRTY: "VACANT_DIRTY", OCCUPIED: "OCCUPIED", OUT_OF_ORDER: "OUT_OF_ORDER" });
export const occupancyStatusOf = (status) =>
  ({
    [ROOM_STATUS.AVAILABLE]: OCCUPANCY_STATUS.VACANT_CLEAN,
    [ROOM_STATUS.RESERVED]: OCCUPANCY_STATUS.VACANT_CLEAN,
    [ROOM_STATUS.DIRTY]: OCCUPANCY_STATUS.VACANT_DIRTY,
    [ROOM_STATUS.CLEANING]: OCCUPANCY_STATUS.VACANT_DIRTY,
    [ROOM_STATUS.OCCUPIED]: OCCUPANCY_STATUS.OCCUPIED,
    [ROOM_STATUS.MAINTENANCE]: OCCUPANCY_STATUS.OUT_OF_ORDER,
  })[status] ?? null;

/**
 * Statuses an administrator may request by hand. AVAILABLE means "ready" and
 * resolves to RESERVED when a confirmed reservation is assigned. OCCUPIED,
 * RESERVED and CLEANING are only ever set by the workflows that own them.
 */
export const ADMIN_SETTABLE_ROOM_STATUSES = Object.freeze([ROOM_STATUS.AVAILABLE, ROOM_STATUS.DIRTY, ROOM_STATUS.MAINTENANCE]);

/**
 * Room — D3 Rooms. isActive lets an administrator take a room out of
 * inventory without deleting its history. archivedAt marks a "deleted" room
 * that still has historical reservations (soft delete): it is hidden from
 * every list and from availability, but its reservations, stays and bills keep
 * pointing at it. Rooms without any history are deleted permanently.
 *
 * roomType references room_types.name (see RoomType.js); the row is created
 * automatically the first time a room uses a new type name.
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
    status: { type: DataTypes.ENUM(...Object.values(ROOM_STATUS)), allowNull: false, defaultValue: ROOM_STATUS.AVAILABLE },
    statusChangedAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastCleanedAt: { type: DataTypes.DATE, allowNull: true },
    lastCleanedBy: { type: DataTypes.INTEGER, allowNull: true },
    // The room has not been cleaned since it was vacated. Maintained only by roomStatusService:
    // set when the room becomes DIRTY / CLEANING (or goes into MAINTENANCE from them), cleared
    // only by a verified cleaning completion or the front desk's "Mark clean". It survives
    // MAINTENANCE, so ending maintenance can never skip housekeeping.
    cleaningRequired: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "rooms",
    indexes: [{ fields: ["room_type"] }, { fields: ["status"] }],
  }
);
