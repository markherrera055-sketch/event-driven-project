/**
 * Restaurant charges — front-desk review of purchase notifications received
 * from the external Restaurant POS (integrations/pos/orderService.js stores
 * them in pos_orders).
 *
 *   Approve  (receptionist) → posted to the guest folio through the SAME
 *            folioService.postFolioCharge() used for every other folio charge,
 *            in one transaction with the status change → ADDED_TO_FOLIO.
 *            The charge is outstanding: it is billed through v_bill_total and
 *            paid by the guest at checkout. Nothing is recorded as paid.
 *   Reject   (receptionist) → REJECTED with a reason; never billed.
 *
 * Safety:
 *  - the order row is locked FOR UPDATE, so two receptionists approving at
 *    the same time produce exactly one charge (the second gets 409);
 *  - the stay and bill are locked and re-checked at approval time (in-house,
 *    folio open) — the match made when the order arrived is only a suggestion;
 *  - stay_charges (source_system, external_transaction_id) is unique, and a
 *    charge already posted through the legacy /pos/room-charges endpoint for
 *    the same POS order is detected, so an order is never billed twice;
 *  - an uncertain match (NEEDS_GUEST_VERIFICATION) or choosing a different
 *    stay than the suggested one requires a written verification note.
 *
 * Billing guard (checkout): confirmBill() refuses while orders referring to
 * the stay's reservation are still awaiting review (assertNoOpenPosOrders).
 */
import { Op, UniqueConstraintError } from "sequelize";
import {
  PosOrder,
  Stay,
  StayCharge,
  Reservation,
  POS_ORDER_STATUS,
  OPEN_POS_ORDER_STATUSES,
  STAY_STATUS,
} from "../models/index.js";
import { conflict, notFound, validationError } from "../utils/errors.js";
import { pageMeta } from "../utils/http.js";
import { withTransaction } from "./tx.js";
import { postFolioCharge, isFolioOpen } from "./folioService.js";
import { emit, EVENTS } from "./domainEvents.js";
import { posOrderReviewedData } from "./eventPayloads.js";
import { posOrderJSON, posOrderRef } from "./serializers.js";
import { logger } from "../utils/logger.js";

/** Folio charges created from POS orders carry the POS's own system name. */
export const POS_CHARGE_SOURCE = "POS";

/** stay_charges.external_transaction_id of the charge created for an order: "<restaurant>:<order id>". */
export const posChargeReference = (order) => `${order.restaurantId}:${order.externalOrderId}`;

const detailInclude = [
  { association: "reservation", include: ["room", "guest"] },
  { association: "reviewer", attributes: ["id", "fullName", "role"] },
  { association: "adjustmentResolver", attributes: ["id", "fullName", "role"] },
];

const isOpen = (order) => OPEN_POS_ORDER_STATUSES.includes(order.status);

const assertOpen = (order) => {
  if (!isOpen(order)) {
    throw conflict("ORDER_ALREADY_REVIEWED", `This purchase is already ${order.status.replace(/_/g, " ").toLowerCase()}.`, { status: order.status });
  }
};

// ── Queue ────────────────────────────────────────────────────────────────────

/** status: a POS_ORDER_STATUS, or OPEN (awaiting review). needsAdjustment: voided after posting, unresolved. */
export async function listPosOrders({ status, search, reservationId, needsAdjustment, page = 1, limit = 25, offset = 0 } = {}) {
  const where = {};
  if (status === "OPEN") where.status = OPEN_POS_ORDER_STATUSES;
  else if (status) where.status = status;
  if (reservationId) where.matchedReservationId = reservationId;
  if (needsAdjustment !== undefined) where.needsAdjustment = needsAdjustment;
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [
      { externalOrderId: like },
      { customerName: like },
      { roomNumber: like },
      { reservationReference: like },
      { "$reservation.reservation_code$": like },
    ];
  }
  const { rows, count } = await PosOrder.findAndCountAll({
    where,
    include: detailInclude,
    order: [["receivedAt", "DESC"], ["id", "DESC"]],
    limit,
    offset,
  });
  return { data: rows.map(posOrderJSON), meta: pageMeta({ page, limit }, count) };
}

/**
 * Counts for the notification badge (polled by every staff page). Counts and
 * the id of the newest open order only — no guest or order details.
 */
export async function posOrderSummary() {
  const [pendingReview, needsVerification, needsAdjustment, latestOpenId] = await Promise.all([
    PosOrder.count({ where: { status: POS_ORDER_STATUS.PENDING_REVIEW } }),
    PosOrder.count({ where: { status: POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION } }),
    PosOrder.count({ where: { needsAdjustment: true } }),
    PosOrder.max("id", { where: { status: OPEN_POS_ORDER_STATUSES } }),
  ]);
  return {
    pendingReview,
    needsVerification,
    open: pendingReview + needsVerification,
    needsAdjustment,
    attention: pendingReview + needsVerification + needsAdjustment,
    latestOpenId: latestOpenId || null,
  };
}

/**
 * In-house stays that could be the guest of this order, with why: the
 * reservation the POS referred to, the room number it sent, the guest's
 * last name in the customer name. A hint for staff only — never applied
 * automatically.
 */
async function candidateStays(order) {
  const stays = await Stay.findAll({
    where: { status: STAY_STATUS.IN_HOUSE },
    include: [{ association: "reservation", required: true, include: ["room", "guest"] }, "bill"],
    order: [["checkInAt", "DESC"]],
    limit: 500,
  });
  const words = String(order.customerName || "").toLowerCase();
  return stays
    .map((s) => {
      const r = s.reservation;
      const reasons = [];
      if (order.matchedReservationId === r.id) reasons.push("RESERVATION");
      if (order.roomNumber && r.room?.roomNumber === order.roomNumber) reasons.push("ROOM");
      if (r.guest && words && r.guest.lastName && words.includes(r.guest.lastName.toLowerCase())) reasons.push("NAME");
      return {
        stayId: s.id,
        reservationId: r.id,
        reservationCode: r.reservationCode,
        roomNumber: r.room?.roomNumber ?? null,
        guestName: r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : null,
        checkInAt: s.checkInAt,
        checkOutDate: r.checkOutDate,
        folioOpen: isFolioOpen(s.bill),
        suggested: s.id === order.matchedStayId,
        reasons,
      };
    })
    .filter((c) => c.reasons.length)
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.reasons.length - a.reasons.length);
}

export async function getPosOrder(id) {
  const order = await PosOrder.findByPk(id, { include: detailInclude });
  if (!order) throw notFound("Restaurant purchase");
  const json = posOrderJSON(order);
  json.candidates = isOpen(order) ? await candidateStays(order) : [];
  return json;
}

// ── Decisions ────────────────────────────────────────────────────────────────

const toFolioItems = (order) => {
  const lines = (order.items || []).map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: Number(i.unitPrice) }));
  // Keep the stored items adding up to the charged amount, like charges posted by the POS directly.
  if (Number(order.serviceCharge)) lines.push({ name: "Service charge", quantity: 1, unitPrice: Number(order.serviceCharge) });
  if (Number(order.tax)) lines.push({ name: "Tax", quantity: 1, unitPrice: Number(order.tax) });
  if (Number(order.discount)) lines.push({ name: "Discount", quantity: 1, unitPrice: -Number(order.discount) });
  return lines;
};

const chargeCategory = (order) => ((order.items || []).length && order.items.every((i) => i.category === "BEVERAGE") ? "BEVERAGE" : "FOOD");

async function publishReviewed(order, reservation, transaction) {
  await emit(
    EVENTS.POS_ORDER_REVIEWED,
    posOrderReviewedData(order, { orderRef: posOrderRef(order.id), reservation, room: reservation?.room }),
    { transaction }
  );
}

/**
 * Approves an open purchase for the in-house stay the receptionist verified,
 * posting it to that guest's folio as an outstanding charge.
 */
export async function approvePosOrder(id, { stayId, note }, actor) {
  try {
    await withTransaction(null, async (t) => {
      const order = await PosOrder.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!order) throw notFound("Restaurant purchase");
      assertOpen(order);

      const override = order.status === POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION || order.matchedStayId !== stayId;
      if (override && !note) {
        throw validationError({
          note:
            order.status === POS_ORDER_STATUS.NEEDS_GUEST_VERIFICATION
              ? "This purchase could not be matched with certainty. Describe how you verified the guest."
              : "You chose a different stay than the one the POS referred to. Describe how you verified the guest.",
        });
      }

      const stay = await Stay.findByPk(stayId, {
        include: [{ association: "reservation", include: ["room", "guest"] }],
        transaction: t,
        lock: { level: t.LOCK.UPDATE, of: Stay },
      });
      if (!stay) throw validationError({ stayId: "Stay not found." });
      if (stay.status !== STAY_STATUS.IN_HOUSE) {
        throw conflict("STAY_NOT_IN_HOUSE", "This guest has already checked out; the purchase must be settled at the restaurant.");
      }

      // Already on a folio through the legacy direct endpoint (POST /pos/room-charges)?
      const existing = await StayCharge.findOne({
        where: { sourceSystem: POS_CHARGE_SOURCE, externalTransactionId: [posChargeReference(order), order.externalOrderId] },
        transaction: t,
      });
      if (existing) {
        throw conflict("DUPLICATE_TRANSACTION", `This POS order is already on a guest folio (charge ${existing.id}).`, { chargeId: existing.id });
      }

      // FOLIO_CLOSED (bill already confirmed) is raised here, under the bill row lock.
      const charge = await postFolioCharge(
        stay,
        {
          sourceSystem: POS_CHARGE_SOURCE,
          externalTransactionId: posChargeReference(order),
          outlet: order.outletName || `Restaurant ${order.restaurantId}`,
          category: chargeCategory(order),
          description: `Restaurant order ${order.externalOrderId}`.slice(0, 255),
          amount: Number(order.total),
          items: toFolioItems(order),
          transactionAt: order.orderedAt,
        },
        t
      );

      await order.update(
        {
          status: POS_ORDER_STATUS.ADDED_TO_FOLIO,
          matchedReservationId: stay.reservationId,
          matchedStayId: stay.id,
          stayChargeId: charge.id,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
          reviewNote: note || null,
          processingError: null,
        },
        { transaction: t }
      );
      await publishReviewed(order, stay.reservation, t);
      logger.info("pos_order_approved", { posOrderId: order.id, stayId: stay.id, chargeId: charge.id, amount: Number(order.total), override, by: actor.id });
    });
  } catch (err) {
    // A concurrent approval / legacy charge won the unique index.
    if (err instanceof UniqueConstraintError) throw conflict("DUPLICATE_TRANSACTION", "This POS order was already added to a guest folio.");
    throw err;
  }
  return getPosOrder(id);
}

export async function rejectPosOrder(id, { reason }, actor) {
  await withTransaction(null, async (t) => {
    const order = await PosOrder.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!order) throw notFound("Restaurant purchase");
    assertOpen(order);
    await order.update(
      { status: POS_ORDER_STATUS.REJECTED, rejectionReason: reason, reviewedBy: actor.id, reviewedAt: new Date() },
      { transaction: t }
    );
    const reservation = order.matchedReservationId
      ? await Reservation.findByPk(order.matchedReservationId, { include: ["room"], transaction: t })
      : null;
    await publishReviewed(order, reservation, t);
    logger.info("pos_order_rejected", { posOrderId: order.id, by: actor.id });
  });
  return getPosOrder(id);
}

/**
 * The POS voided an order that was already on the folio. The folio charge is
 * never deleted: the receptionist corrects the bill (adjustment, or refund if
 * already paid) and then marks the void as handled here.
 */
export async function resolveVoidedPosOrder(id, actor) {
  await withTransaction(null, async (t) => {
    const order = await PosOrder.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!order) throw notFound("Restaurant purchase");
    if (!order.needsAdjustment) throw conflict("NOTHING_TO_RESOLVE", "This purchase has no void waiting to be handled.");
    await order.update({ needsAdjustment: false, adjustmentResolvedBy: actor.id, adjustmentResolvedAt: new Date() }, { transaction: t });
    logger.info("pos_order_void_resolved", { posOrderId: order.id, by: actor.id });
  });
  return getPosOrder(id);
}

// ── Billing guard ────────────────────────────────────────────────────────────

/** Refuses while purchases referring to this stay's reservation still await review (called by confirmBill). */
export async function assertNoOpenPosOrders(stayId, transaction) {
  const stay = await Stay.findByPk(stayId, { attributes: ["id", "reservationId"], transaction });
  if (!stay) return;
  const count = await PosOrder.count({
    where: { matchedReservationId: stay.reservationId, status: OPEN_POS_ORDER_STATUSES },
    transaction,
  });
  if (count) {
    throw conflict(
      "POS_ORDERS_PENDING",
      `${count} restaurant purchase${count === 1 ? " is" : "s are"} waiting for review for this guest. Approve or reject ${count === 1 ? "it" : "them"} under Restaurant charges before confirming the bill.`,
      { count }
    );
  }
}
