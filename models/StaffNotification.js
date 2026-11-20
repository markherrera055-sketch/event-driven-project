import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * Notification categories shown to front-desk staff (bell, Online Reservations page).
 *
 *   ONLINE_RESERVATION_NEW        a StayBook booking was received and a room is now held for it
 *   ONLINE_RESERVATION_UPDATED    StayBook changed a booking (dates, guests, room, quote, status)
 *   ONLINE_RESERVATION_CANCELLED  StayBook cancelled a booking; the room is released for those dates
 *   ROOM_CONFLICT                 StayBook sent a booking / change for a room that is already taken
 *   SYNC_FAILED                   StayBook's request was refused (unmapped room, invalid data, …),
 *                                 or a webhook to StayBook failed after every retry
 */
export const NOTIFICATION_CATEGORY = Object.freeze({
  ONLINE_RESERVATION_NEW: "ONLINE_RESERVATION_NEW",
  ONLINE_RESERVATION_UPDATED: "ONLINE_RESERVATION_UPDATED",
  ONLINE_RESERVATION_CANCELLED: "ONLINE_RESERVATION_CANCELLED",
  ROOM_CONFLICT: "ROOM_CONFLICT",
  SYNC_FAILED: "SYNC_FAILED",
});

/** Categories that need someone to act (shown in red, listed under "Sync issues"). */
export const PROBLEM_NOTIFICATION_CATEGORIES = Object.freeze([NOTIFICATION_CATEGORY.ROOM_CONFLICT, NOTIFICATION_CATEGORY.SYNC_FAILED]);

/**
 * StaffNotification — one notification for every authorised staff member
 * (receptionists and administrators). Read state is per user
 * (staff_notification_reads), so one clerk opening a notification does not
 * hide it from the others.
 *
 * dedupeKey is unique: a repeated StayBook delivery, a retried request or a
 * concurrent duplicate can never produce a second notification for the same
 * thing. Notifications are never deleted (history).
 *
 * Contains no guest contact data: only the guest's name, the room and the
 * booking reference, which staff see on every reservation screen anyway.
 */
export const StaffNotification = sequelize.define(
  "StaffNotification",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    category: { type: DataTypes.STRING(40), allowNull: false },
    sourceSystem: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "STAYBOOK" },
    title: { type: DataTypes.STRING(160), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    reservationId: { type: DataTypes.INTEGER, allowNull: true },
    externalBookingId: { type: DataTypes.INTEGER, allowNull: true },
    bookingReference: { type: DataTypes.STRING(100), allowNull: true },
    roomNumber: { type: DataTypes.STRING(10), allowNull: true },
    guestName: { type: DataTypes.STRING(160), allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    dedupeKey: { type: DataTypes.STRING(191), allowNull: false, unique: true },
  },
  {
    tableName: "staff_notifications",
    updatedAt: false,
    indexes: [{ fields: ["category", "created_at"] }, { fields: ["reservation_id"] }],
  }
);

/** Which staff member has read which notification (absent row = unread). */
export const StaffNotificationRead = sequelize.define(
  "StaffNotificationRead",
  {
    notificationId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    readAt: { type: DataTypes.DATE, allowNull: false },
  },
  { tableName: "staff_notification_reads", timestamps: false, indexes: [{ fields: ["user_id"] }] }
);
