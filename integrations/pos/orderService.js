/**
 * Restaurant POS (Member 4) → PMS: purchase notifications for front-desk review.
 *
 * The restaurant's POS is its own system of record. When a hotel guest's
 * order is completed it calls POST /pos/orders. The PMS does NOT post the
 * order to the folio: it stores it in pos_orders and the front desk reviews
 * it under "Restaurant charges" (services/posOrderReviewService.js).
 *
 * Matching (never by room number or name alone). The reliable identifier is
 * the PMS reservation (reservation_id or reservation_code, from the in-house
 * lookup or the GuestCheckedIn webhook); guest_id, room_number and
 * customer_name are cross-checks. The order is PENDING_REVIEW with a
 * suggested stay only when every supplied value agrees and the guest is
 * in-house with an open folio; anything else is NEEDS_GUEST_VERIFICATION with
 * the list of issues, and a receptionist must pick the stay explicitly.
 *
 * Money: receiving an order never records a payment. payment_status PAID
 * (the restaurant collected the money) → ALREADY_PAID: kept for information,
 * never billed to the room.
 *
 * Duplicates: (restaurant_id, external_order_id) is unique. A re-delivery with
 * the same content returns the stored order (200, duplicate: true) and creates
 * nothing; a re-delivery with different content is refused (409
 * ORDER_CONFLICT) and recorded on the order; the same order re-sent with
 * order_status VOIDED cancels it (see applyVoid). Concurrent first deliveries
 * are decided by the unique index and retried as re-deliveries.
 *
 * Privacy: responses to the POS carry references, statuses and a masked
 * guest name only; logs carry ids only.
 */
import crypto from "crypto";
import { UniqueConstraintError } from "sequelize";
import {
  PosOrder,
  Reservation,
  StayCharge,
  POS_ORDER_STATUS,
  OPEN_POS_ORDER_STATUSES,
  RESERVATION_STATUS,
  STAY_STATUS,
} from "../../models/index.js";
import { AppError, validationError } from "../../utils/errors.js";
import { sumMoney, toCents, fromCents } from "../../utils/money.js";
import { config } from "../../config/index.js";
import { withTransaction } from "../../services/tx.js";
import { isFolioOpen } from "../../services/folioService.js";
import { posOrderRef } from "../../services/serializers.js";
import { POS_CHARGE_SOURCE, posChargeReference } from "../../services/posOrderReviewService.js";
import { logger } from "../../utils/logger.js";
import { guestNameMatches } from "./posService.js";

export const POS_PAYMENT_STATUS = Object.freeze({ CHARGE_TO_ROOM: "CHARGE_TO_ROOM", UNPAID: "UNPAID", PAID: "PAID" });
export const POS_ORDER_LIFECYCLE = Object.freeze({ COMPLETED: "COMPLETED", VOIDED: "VOIDED" });
export const ITEM_CATEGORIES = Object.freeze(["FOOD", "BEVERAGE"]);

/** Why an order could not be matched with certainty (shown to staff and returned to the POS). */
export const MATCH_ISSUES = Object.freeze({
  NO_RESERVATION_REFERENCE: "NO_RESERVATION_REFERENCE",
  RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
  RESERVATION_REFERENCE_MISMATCH: "RESERVATION_REFERENCE_MISMATCH",
  GUEST_ID_MISMATCH: "GUEST_ID_MISMATCH",
  NOT_IN_HOUSE: "NOT_IN_HOUSE",
  ROOM_MISMATCH: "ROOM_MISMATCH",
  NAME_MISMATCH: "NAME_MISMATCH",
  ORDERED_BEFORE_CHECK_IN: "ORDERED_BEFORE_CHECK_IN",
  FOLIO_CLOSED: "FOLIO_CLOSED",
});

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const maskedName = (guest) => (guest ? `${guest.firstName.charAt(0)}. ${guest.lastName}` : null);

// ── Validation beyond the schema ─────────────────────────────────────────────

function checkOrder(input) {
  const errors = {};
  const allowed = config.integrations.posOrders.restaurantIds;
  if (allowed.length && !allowed.includes(input.restaurant_id)) {
    errors.restaurant_id = "This restaurant is not connected to this hotel.";
  }
  if (input.currency !== config.hotel.currency) errors.currency = `Only ${config.hotel.currency} is accepted.`;
  if (!input.items?.length) errors.items = "At least one item is required.";
  else {
    const itemsTotal = sumMoney(...input.items.map((i) => fromCents(toCents(i.unit_price) * i.quantity)));
    if (toCents(itemsTotal) !== toCents(input.subtotal)) {
      errors.subtotal = `Subtotal (${input.subtotal}) does not equal the sum of the items (${itemsTotal}).`;
    }
  }
  const expected = fromCents(toCents(input.subtotal) + toCents(input.service_charge) + toCents(input.tax) - toCents(input.discount));
  if (!errors.subtotal && toCents(expected) !== toCents(input.total)) {
    errors.total = `Total (${input.total}) must equal subtotal + service_charge + tax − discount (${expected}).`;
  }
  if (input.ordered_at > new Date(Date.now() + CLOCK_SKEW_MS)) errors.ordered_at = "The order time cannot be in the future.";
  if (Object.keys(errors).length) throw validationError(errors);
}

/** Fingerprint of everything that makes up the order except its lifecycle status (a void re-sends the same order). */
const contentHash = (input) => {
  const { order_status, ...content } = input;
  const canonical = JSON.stringify(content, (key, value) =>
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
      : value
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
};

// ── Matching ─────────────────────────────────────────────────────────────────

async function matchGuest(input, transaction) {
  const include = ["room", "guest", { association: "stay", include: ["bill"] }];
  const code = input.reservation_code?.toUpperCase();
  let reservation = null;
  if (input.reservation_id) reservation = await Reservation.findByPk(input.reservation_id, { include, transaction });
  else if (code) reservation = await Reservation.findOne({ where: { reservationCode: code }, include, transaction });

  const issues = [];
  let stay = null;
  if (!input.reservation_id && !code) issues.push(MATCH_ISSUES.NO_RESERVATION_REFERENCE);
  else if (!reservation) issues.push(MATCH_ISSUES.RESERVATION_NOT_FOUND);
  else {
    if (input.reservation_id && code && reservation.reservationCode !== code) issues.push(MATCH_ISSUES.RESERVATION_REFERENCE_MISMATCH);
    if (input.guest_id && input.guest_id !== reservation.guestId) issues.push(MATCH_ISSUES.GUEST_ID_MISMATCH);
    const inHouse = reservation.status === RESERVATION_STATUS.CHECKED_IN && reservation.stay?.status === STAY_STATUS.IN_HOUSE;
    if (!inHouse) issues.push(MATCH_ISSUES.NOT_IN_HOUSE);
    if (input.room_number && reservation.room?.roomNumber !== input.room_number) issues.push(MATCH_ISSUES.ROOM_MISMATCH);
    if (input.customer_name && reservation.guest && !guestNameMatches(input.customer_name, reservation.guest)) {
      issues.push(MATCH_ISSUES.NAME_MISMATCH);
    }
    if (inHouse) {
      if (input.ordered_at < new Date(new Date(reservation.stay.checkInAt).getTime() - CLOCK_SKEW_MS)) {
        issues.push(MATCH_ISSUES.ORDERED_BEFORE_CHECK_IN);
      }
      if (!isFolioOpen(reservation.stay.bill)) issues.push(MATCH_ISSUES.FOLIO_CLOSED);
      stay = reservation.stay;
    }
  }
  // The suggested stay is only kept when nothing disagrees.
  return { reservation, stay: issues.length ? null : stay, issues };
}

// ── Response to the POS ──────────────────────────────────────────────────────

async function orderView(order, { duplicate = false } = {}) {
  let reservation = null;
  if (order.matchedStayId && order.matchedReservationId) {
    reservation = await Reservation.findByPk(order.matchedReservationId, { include: ["room", "guest"] });
  }
  return {
    order_ref: posOrderRef(order.id),
    restaurant_id: order.restaurantId,
    external_order_id: order.externalOrderId,
    status: order.status,
    verification_reasons: order.status === POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION ? order.matchIssues || [] : [],
    // Only once the PMS has tied the order to a stay (certain match or staff decision).
    reservation_id: reservation?.id ?? null,
    reservation_code: reservation?.reservationCode ?? null,
    room_number: reservation?.room?.roomNumber ?? null,
    guest_display_name: maskedName(reservation?.guest),
    total: Number(order.total),
    currency: order.currency,
    payment_status: order.posPaymentStatus,
    order_status: order.posOrderStatus,
    charge_id: order.stayChargeId ?? null,
    received_at: order.receivedAt,
    reviewed_at: order.reviewedAt ?? null,
    rejection_reason: order.rejectionReason ?? null,
    voided_at: order.voidedAt ?? null,
    duplicate,
  };
}

// ── Re-deliveries and voids ──────────────────────────────────────────────────

/** The POS voided the order (same order re-sent with order_status VOIDED). The folio is never changed automatically. */
function applyVoid(order, now) {
  const changes = { posOrderStatus: POS_ORDER_LIFECYCLE.VOIDED, voidedAt: now };
  if (OPEN_POS_ORDER_STATUSES.includes(order.status)) {
    Object.assign(changes, { status: POS_ORDER_STATUS.REJECTED, rejectionReason: "Voided by the restaurant POS before review." });
  } else if (order.status === POS_ORDER_STATUS.ADDED_TO_FOLIO) {
    // Already an outstanding folio charge: the front desk corrects the bill and marks the void handled.
    changes.needsAdjustment = true;
  }
  return changes;
}

async function redeliver(order, input, hash, t) {
  const now = new Date();
  const delivery = { lastDeliveryAt: now, deliveryCount: order.deliveryCount + 1 };
  if (order.contentHash !== hash) {
    await order.update(
      { ...delivery, processingError: `Re-delivered at ${now.toISOString()} with different content; the change was not applied.` },
      { transaction: t }
    );
    logger.warn("pos_order_conflict", { posOrderId: order.id, restaurantId: order.restaurantId });
    return { order, conflict: true };
  }
  if (input.order_status === POS_ORDER_LIFECYCLE.VOIDED && !order.voidedAt) {
    const changes = applyVoid(order, now);
    await order.update({ ...delivery, ...changes }, { transaction: t });
    (changes.needsAdjustment ? logger.warn : logger.info)("pos_order_voided", { posOrderId: order.id, status: order.status, needsAdjustment: !!changes.needsAdjustment });
    return { order, voided: true };
  }
  // Same order again (webhook retry), or a late copy of the original after a void: nothing changes.
  await order.update(delivery, { transaction: t });
  return { order, duplicate: true };
}

async function processOnce(input, hash) {
  return withTransaction(null, async (t) => {
    const key = { sourceSystem: POS_CHARGE_SOURCE, restaurantId: input.restaurant_id, externalOrderId: input.external_order_id };
    const existing = await PosOrder.findOne({ where: key, transaction: t, lock: t.LOCK.UPDATE });
    if (existing) return redeliver(existing, input, hash, t);

    if (input.order_status === POS_ORDER_LIFECYCLE.VOIDED) {
      throw validationError({ order_status: "A new order must be COMPLETED. VOIDED is only accepted for an order that was already sent." });
    }

    const { reservation, stay, issues } = await matchGuest(input, t);
    let status;
    if (input.payment_status === POS_PAYMENT_STATUS.PAID) status = POS_ORDER_STATUS.ALREADY_PAID;
    else status = issues.length ? POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION : POS_ORDER_STATUS.PENDING_REVIEW;

    // Charged already through the legacy direct endpoint (POST /pos/room-charges) with the same id?
    let legacyCharge = null;
    if (status !== POS_ORDER_STATUS.ALREADY_PAID) {
      legacyCharge = await StayCharge.findOne({
        where: { sourceSystem: POS_CHARGE_SOURCE, externalTransactionId: [posChargeReference(key), input.external_order_id] },
        transaction: t,
      });
    }

    const now = new Date();
    const order = await PosOrder.create(
      {
        ...key,
        outletName: input.outlet_name || null,
        status: legacyCharge ? POS_ORDER_STATUS.ADDED_TO_FOLIO : status,
        customerName: input.customer_name || null,
        guestReference: input.guest_id || null,
        reservationReference: input.reservation_code?.toUpperCase() || (input.reservation_id ? String(input.reservation_id) : null),
        roomNumber: input.room_number || null,
        items: input.items.map((i) => ({
          sku: i.sku || null,
          name: i.name,
          description: i.description || null,
          category: i.category || null,
          quantity: i.quantity,
          unitPrice: i.unit_price,
          lineTotal: fromCents(toCents(i.unit_price) * i.quantity),
        })),
        subtotal: input.subtotal,
        serviceCharge: input.service_charge ?? 0,
        tax: input.tax ?? 0,
        discount: input.discount ?? 0,
        total: input.total,
        currency: input.currency,
        orderedAt: input.ordered_at,
        posPaymentStatus: input.payment_status,
        posOrderStatus: input.order_status,
        contentHash: hash,
        matchedReservationId: legacyCharge ? null : reservation?.id ?? null,
        matchedStayId: legacyCharge ? legacyCharge.stayId : stay?.id ?? null,
        matchIssues: issues.length ? issues : null,
        stayChargeId: legacyCharge?.id ?? null,
        receivedAt: now,
        lastDeliveryAt: now,
        processingError: legacyCharge ? `Already posted to the folio through POST /pos/room-charges (charge ${legacyCharge.id}); not billed again.` : null,
      },
      { transaction: t }
    );
    if (legacyCharge) {
      // Keep the link to the reservation of the existing charge for the staff screens.
      const s = await legacyCharge.getStay({ transaction: t });
      await order.update({ matchedReservationId: s.reservationId }, { transaction: t });
    }
    logger.info("pos_order_received", { posOrderId: order.id, restaurantId: key.restaurantId, status: order.status, issues, amount: input.total });
    return { order, created: true };
  });
}

const isRetryable = (err) => err instanceof UniqueConstraintError || err?.parent?.code === "ER_LOCK_DEADLOCK";

/**
 * Receives one purchase notification. Returns { status: 202 | 200, data }.
 * Throws 422 for invalid orders and 409 ORDER_CONFLICT for a changed re-delivery.
 */
export async function receiveOrder(rawInput) {
  const input = {
    ...rawInput,
    restaurant_id: rawInput.restaurant_id || config.integrations.posOrders.defaultRestaurantId,
    currency: rawInput.currency.toUpperCase(),
    service_charge: rawInput.service_charge ?? 0,
    tax: rawInput.tax ?? 0,
    discount: rawInput.discount ?? 0,
  };
  checkOrder(input);
  const hash = contentHash(input);

  let result;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await processOnce(input, hash);
      break;
    } catch (err) {
      // Two first deliveries of the same order at once: the loser re-reads it as a re-delivery.
      if (attempt < 3 && isRetryable(err)) continue;
      throw err;
    }
  }

  if (result.conflict) {
    throw new AppError(
      409,
      "ORDER_CONFLICT",
      "This order was already received with different content. Orders cannot be changed: void it (order_status VOIDED) and send a new order id.",
      await orderView(result.order)
    );
  }
  return { status: result.created ? 202 : 200, data: await orderView(result.order, { duplicate: !!result.duplicate }) };
}

export async function getOrder(restaurantId, externalOrderId) {
  const order = await PosOrder.findOne({ where: { sourceSystem: POS_CHARGE_SOURCE, restaurantId, externalOrderId } });
  if (!order) throw new AppError(404, "NOT_FOUND", "Order not found.");
  return orderView(order);
}
