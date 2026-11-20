import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/** Last synchronisation applied from the external system. */
export const EXTERNAL_SYNC_STATUS = Object.freeze({
  ACKNOWLEDGED: "ACKNOWLEDGED", // created in the PMS
  UPDATED: "UPDATED", // a later revision was applied
  CANCELLED: "CANCELLED", // cancelled from the external system
});

/**
 * ExternalBooking — the external system's view of a booking that became a PMS
 * reservation (1 — 1 with reservations). The reservation itself stays a normal
 * PMS reservation (source RESERVATION_SYSTEM, externalReservationId = the
 * booking reference); this row keeps what only the external system knows:
 *
 *  - its own ids (sourceBookingId, bookingReference) and hotel / room ids;
 *  - the price it QUOTED to the guest (nightlyRate, totalAmount, currency) —
 *    informational only: the PMS bills from its own rates at checkout;
 *  - its booking status (e.g. StayBook LOCAL_CONFIRMED / ADMIN_CONFIRMED);
 *  - paymentMode (e.g. SIMULATED) — never recorded as a collected payment;
 *  - sourceUpdatedAt, the external revision, so late or repeated updates
 *    cannot overwrite a newer one.
 * No guest contact data is stored here (it lives on the guest record).
 */
export const ExternalBooking = sequelize.define(
  "ExternalBooking",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    sourceSystem: { type: DataTypes.STRING(30), allowNull: false },
    sourceBookingId: { type: DataTypes.STRING(100), allowNull: false },
    bookingReference: { type: DataTypes.STRING(100), allowNull: false },
    reservationId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    hotelId: { type: DataTypes.STRING(50), allowNull: true },
    externalRoomId: { type: DataTypes.STRING(50), allowNull: true },
    nightlyRate: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    totalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    currency: { type: DataTypes.CHAR(3), allowNull: true },
    bookingStatus: { type: DataTypes.STRING(30), allowNull: true },
    paymentMode: { type: DataTypes.STRING(30), allowNull: true },
    // DATETIME(3): a plain DATETIME rounds to whole seconds, which would make an exact retry look older or newer.
    sourceUpdatedAt: { type: DataTypes.DATE(3), allowNull: true },
    syncStatus: {
      type: DataTypes.ENUM(...Object.values(EXTERNAL_SYNC_STATUS)),
      allowNull: false,
      defaultValue: EXTERNAL_SYNC_STATUS.ACKNOWLEDGED,
    },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "external_bookings",
    indexes: [
      { unique: true, fields: ["source_system", "source_booking_id"], name: "uq_external_booking_id" },
      { unique: true, fields: ["source_system", "booking_reference"], name: "uq_external_booking_reference" },
    ],
  }
);
