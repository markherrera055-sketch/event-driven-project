import { DataTypes } from "sequelize";
import { sequelize } from "./db.js";

/**
 * Review status of a purchase notification from the Restaurant POS.
 *
 *   PENDING_REVIEW            reservation identified with no discrepancies; waiting for a receptionist
 *   NEEDS_GUEST_VERIFICATION  the guest / stay could not be identified with certainty (see matchIssues);
 *                             a receptionist must choose the stay explicitly and give a note
 *   ADDED_TO_FOLIO            approved: posted to the guest folio as an outstanding charge (stayChargeId)
 *   REJECTED                  rejected by staff, or voided by the POS before review — never billed
 *   ALREADY_PAID              the restaurant collected payment itself — kept for information, never billed
 *
 * There is no resting "APPROVED" status: approval and posting to the folio
 * happen in one transaction, so an approved order is always ADDED_TO_FOLIO.
 */
export const POS_ORDER_STATUS = Object.freeze({
  PENDING_REVIEW: "PENDING_REVIEW",
  NEEDS_GUEST_VERIFICATION: "NEEDS_GUEST_VERIFICATION",
  ADDED_TO_FOLIO: "ADDED_TO_FOLIO",
  REJECTED: "REJECTED",
  ALREADY_PAID: "ALREADY_PAID",
});

/** Statuses that still need a receptionist's decision. */
export const OPEN_POS_ORDER_STATUSES = Object.freeze([POS_ORDER_STATUS.PENDING_REVIEW, POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION]);

/**
 * PosOrder — one purchase notification received from the external Restaurant
 * POS (its own system of record). The PMS never changes the POS transaction;
 * this row is the review queue entry and the synchronisation record:
 *
 *  - identity: (sourceSystem, restaurantId, externalOrderId) is unique, so a
 *    repeated webhook delivery can never create a second entry, notification
 *    or charge; contentHash detects a re-delivery whose content changed;
 *  - what the POS sent (customer, references, items, amounts, POS payment and
 *    order status) exactly as received;
 *  - matching result: the reservation the POS referred to and, when the
 *    match is certain, the in-house stay; otherwise the list of issues;
 *  - review: who approved / rejected it and when, the folio charge created;
 *  - sync: deliveries, last delivery, processing error, void after posting.
 */
export const PosOrder = sequelize.define(
  "PosOrder",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    sourceSystem: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "POS" },
    restaurantId: { type: DataTypes.STRING(40), allowNull: false },
    outletName: { type: DataTypes.STRING(80), allowNull: true },
    externalOrderId: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.ENUM(...Object.values(POS_ORDER_STATUS)), allowNull: false },

    // As received from the POS
    customerName: { type: DataTypes.STRING(160), allowNull: true },
    guestReference: { type: DataTypes.INTEGER, allowNull: true },
    reservationReference: { type: DataTypes.STRING(30), allowNull: true },
    roomNumber: { type: DataTypes.STRING(10), allowNull: true },
    items: { type: DataTypes.JSON, allowNull: false },
    subtotal: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    serviceCharge: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    tax: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    discount: { type: DataTypes.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
    total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    currency: { type: DataTypes.CHAR(3), allowNull: false },
    orderedAt: { type: DataTypes.DATE, allowNull: false },
    posPaymentStatus: { type: DataTypes.STRING(20), allowNull: false },
    posOrderStatus: { type: DataTypes.STRING(20), allowNull: false },
    contentHash: { type: DataTypes.CHAR(64), allowNull: false },

    // Matching
    matchedReservationId: { type: DataTypes.INTEGER, allowNull: true },
    matchedStayId: { type: DataTypes.INTEGER, allowNull: true },
    matchIssues: { type: DataTypes.JSON, allowNull: true },

    // Review
    stayChargeId: { type: DataTypes.INTEGER, allowNull: true, unique: true },
    reviewedBy: { type: DataTypes.INTEGER, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
    reviewNote: { type: DataTypes.STRING(255), allowNull: true },
    rejectionReason: { type: DataTypes.STRING(255), allowNull: true },

    // Synchronisation
    receivedAt: { type: DataTypes.DATE, allowNull: false },
    lastDeliveryAt: { type: DataTypes.DATE, allowNull: false },
    deliveryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    processingError: { type: DataTypes.STRING(255), allowNull: true },
    voidedAt: { type: DataTypes.DATE, allowNull: true },
    // Voided by the POS after it was added to the folio: the front desk must correct the bill (adjustment).
    needsAdjustment: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    adjustmentResolvedBy: { type: DataTypes.INTEGER, allowNull: true },
    adjustmentResolvedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "pos_orders",
    indexes: [
      { unique: true, fields: ["source_system", "restaurant_id", "external_order_id"], name: "uq_pos_order_external" },
      { fields: ["status", "received_at"] },
      { fields: ["matched_reservation_id"] },
    ],
  }
);
