import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * ReservationStatus from the class diagram, plus CANCELLED which is required
 * so cancellations from the Hotel Reservation System can be synchronised.
 */
export const RESERVATION_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  CHECKED_IN: "CHECKED_IN",
  CHECKED_OUT: "CHECKED_OUT",
  CANCELLED: "CANCELLED",
});

/** Statuses that hold a room (count against availability). */
export const ACTIVE_RESERVATION_STATUSES = [RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.CHECKED_IN];

export const RESERVATION_SOURCE = Object.freeze({
  FRONT_DESK: "FRONT_DESK",
  RESERVATION_SYSTEM: "RESERVATION_SYSTEM",
});

/**
 * Reservation — D2 Reservations. Guest 1 — 0..* Reservation; Reservation
 * 0..* — 1 Room ("books"). roomId may be null until the front desk assigns a
 * room to a reservation that came in by room type (external bookings).
 * roomType is kept so availability can be checked before a room is assigned;
 * once a room is assigned the service layer keeps both consistent.
 *
 * External identifiers (externalReservationId, bookingReference) are kept
 * separate from the internal primary key and are unique per source.
 */
export const Reservation = sequelize.define(
  "Reservation",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    reservationCode: { type: DataTypes.STRING(20), allowNull: false, unique: true },
    guestId: { type: DataTypes.INTEGER, allowNull: false },
    roomId: { type: DataTypes.INTEGER, allowNull: true },
    roomType: { type: DataTypes.STRING(50), allowNull: false },
    checkInDate: { type: DataTypes.DATEONLY, allowNull: false },
    checkOutDate: { type: DataTypes.DATEONLY, allowNull: false },
    numGuests: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.ENUM(...Object.values(RESERVATION_STATUS)),
      allowNull: false,
      defaultValue: RESERVATION_STATUS.CONFIRMED,
    },
    source: {
      type: DataTypes.ENUM(...Object.values(RESERVATION_SOURCE)),
      allowNull: false,
      defaultValue: RESERVATION_SOURCE.FRONT_DESK,
    },
    externalReservationId: { type: DataTypes.STRING(100), allowNull: true },
    bookingReference: { type: DataTypes.STRING(100), allowNull: true },
    externalPaymentStatus: { type: DataTypes.STRING(30), allowNull: true },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: true },
    cancelledAt: { type: DataTypes.DATE, allowNull: true },
    cancellationReason: { type: DataTypes.STRING(255), allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "reservations",
    indexes: [
      { unique: true, fields: ["source", "external_reservation_id"], name: "uq_reservation_external" },
      { fields: ["status"] },
      { fields: ["check_in_date"] },
      { fields: ["check_out_date"] },
      { fields: ["room_type", "status"] },
    ],
  }
);
