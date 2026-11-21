/**
 * API resources: convert Sequelize instances into stable JSON shapes.
 * Only fields that staff screens need are exposed (no password hashes, no
 * internal audit columns beyond who/when).
 */
import { nightsBetween } from "../utils/dates.js";

const plain = (m) => (m && typeof m.get === "function" ? m.get({ plain: true }) : m);

export const userRef = (u) => {
  const x = plain(u);
  return x ? { id: x.id, fullName: x.fullName, role: x.role } : null;
};

export const userJSON = (u) => {
  const x = plain(u);
  if (!x) return null;
  return {
    id: x.id,
    fullName: x.fullName,
    username: x.username,
    role: x.role,
    isActive: x.isActive,
    mustChangePassword: !!x.mustChangePassword,
    passwordChangedAt: x.passwordChangedAt ?? null,
    lastLoginAt: x.lastLoginAt,
    createdAt: x.createdAt,
  };
};

export const guestJSON = (g) => {
  const x = plain(g);
  if (!x) return null;
  return {
    id: x.id,
    firstName: x.firstName,
    lastName: x.lastName,
    fullName: `${x.firstName} ${x.lastName}`,
    email: x.email,
    phone: x.phone,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
  };
};

export const roomJSON = (r) => {
  const x = plain(r);
  if (!x) return null;
  return {
    id: x.id,
    roomNumber: x.roomNumber,
    roomType: x.roomType,
    floor: x.floor ?? null,
    capacity: x.capacity,
    nightlyRate: Number(x.nightlyRate),
    description: x.description ?? null,
    amenities: Array.isArray(x.amenities) ? x.amenities : [],
    status: x.status,
    statusChangedAt: x.statusChangedAt ?? null,
    isActive: x.isActive,
    archivedAt: x.archivedAt ?? null,
    // Convenience flag for screens: waiting for, or in, housekeeping.
    needsCleaning: x.status === "DIRTY" || x.status === "CLEANING",
    // Also true for a room that went into MAINTENANCE before it was cleaned (it cannot be made ready yet).
    cleaningRequired: x.status === "DIRTY" || x.status === "CLEANING" || !!x.cleaningRequired,
    lastCleanedAt: x.lastCleanedAt,
    lastCleanedBy: x.cleaner ? userRef(x.cleaner) : x.lastCleanedBy ?? null,
  };
};

export const verificationJSON = (v) => {
  const x = plain(v);
  if (!x) return null;
  return {
    id: x.id,
    attemptNo: x.attemptNo,
    idType: x.idType,
    idNumberLast4: x.idNumberLast4,
    result: x.result,
    failureReason: x.failureReason,
    verifiedBy: x.verifier ? userRef(x.verifier) : x.verifiedBy,
    attemptedAt: x.attemptedAt,
  };
};

export const chargeJSON = (c) => {
  const x = plain(c);
  if (!x) return null;
  return {
    id: x.id,
    sourceSystem: x.sourceSystem,
    externalTransactionId: x.externalTransactionId,
    outlet: x.outlet,
    category: x.category,
    description: x.description,
    amount: Number(x.amount),
    items: x.items,
    transactionAt: x.transactionAt,
    createdAt: x.createdAt,
  };
};

export const receiptJSON = (r) => {
  const x = plain(r);
  return x ? { id: x.id, receiptNo: x.receiptNo, issuedAt: x.issuedAt, paymentId: x.paymentId } : null;
};

export const paymentJSON = (p) => {
  const x = plain(p);
  if (!x) return null;
  return {
    id: x.id,
    billId: x.billId,
    attemptNo: x.attemptNo,
    amount: Number(x.amount),
    method: x.method,
    status: x.status,
    gatewayReference: x.gatewayReference,
    failureReason: x.failureReason,
    receivedBy: x.receiver ? userRef(x.receiver) : x.receivedBy,
    processedAt: x.processedAt,
    receipt: x.receipt ? receiptJSON(x.receipt) : null,
  };
};

export const adjustmentJSON = (a) => {
  const x = plain(a);
  if (!x) return null;
  return {
    id: x.id,
    amount: Number(x.amount),
    reason: x.reason,
    adjustedBy: x.adjuster ? userRef(x.adjuster) : x.adjustedBy,
    adjustedAt: x.adjustedAt,
  };
};

export const billJSON = (b, totals) => {
  const x = plain(b);
  if (!x) return null;
  return {
    id: x.id,
    stayId: x.stayId,
    nights: x.nights,
    nightlyRate: Number(x.nightlyRate),
    roomCharge: Number(x.roomCharge),
    status: x.status,
    generatedBy: x.generator ? userRef(x.generator) : x.generatedBy,
    generatedAt: x.generatedAt,
    confirmedAt: x.confirmedAt,
    paidAt: x.paidAt,
    totals: totals || undefined,
    adjustments: x.adjustments ? x.adjustments.map(adjustmentJSON) : undefined,
    payments: x.payments ? x.payments.map(paymentJSON) : undefined,
  };
};

export const stayJSON = (s) => {
  const x = plain(s);
  if (!x) return null;
  return {
    id: x.id,
    reservationId: x.reservationId,
    status: x.status,
    checkInAt: x.checkInAt,
    checkOutAt: x.checkOutAt,
    checkedInBy: x.checkInStaff ? userRef(x.checkInStaff) : x.checkedInBy,
    checkedOutBy: x.checkOutStaff ? userRef(x.checkOutStaff) : x.checkedOutBy,
    reservation: x.reservation ? reservationJSON(x.reservation) : undefined,
    charges: x.charges ? x.charges.map(chargeJSON) : undefined,
    bill: x.bill ? billJSON(x.bill) : x.bill === null ? null : undefined,
  };
};

export const reservationJSON = (r) => {
  const x = plain(r);
  if (!x) return null;
  const verifications = x.verifications ? [...x.verifications].sort((a, b) => a.attemptNo - b.attemptNo) : undefined;
  return {
    id: x.id,
    reservationCode: x.reservationCode,
    status: x.status,
    source: x.source,
    roomType: x.roomType,
    checkInDate: x.checkInDate,
    checkOutDate: x.checkOutDate,
    nights: nightsBetween(x.checkInDate, x.checkOutDate),
    numGuests: x.numGuests,
    externalReservationId: x.externalReservationId,
    bookingReference: x.bookingReference,
    externalPaymentStatus: x.externalPaymentStatus,
    notes: x.notes,
    cancelledAt: x.cancelledAt,
    cancellationReason: x.cancellationReason,
    lastSyncedAt: x.lastSyncedAt,
    createdAt: x.createdAt,
    updatedAt: x.updatedAt,
    guest: x.guest ? guestJSON(x.guest) : undefined,
    room: x.room ? roomJSON(x.room) : x.room === null ? null : undefined,
    verifications: verifications ? verifications.map(verificationJSON) : undefined,
    identityVerified: verifications ? verifications.length > 0 && verifications.at(-1).result === "VERIFIED" : undefined,
    stay: x.stay ? stayJSON(x.stay) : x.stay === null ? null : undefined,
  };
};

/** Human-friendly reference of a restaurant purchase notification (PO-000042). */
export const posOrderRef = (id) => `PO-${String(id).padStart(6, "0")}`;

const money2 = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Restaurant POS purchase for STAFF screens (session API only). Contains the
 * customer name as the POS sent it, which is never returned to the POS.
 */
export const posOrderJSON = (o) => {
  const x = plain(o);
  if (!x) return null;
  const r = x.reservation;
  return {
    id: x.id,
    orderRef: posOrderRef(x.id),
    restaurantId: x.restaurantId,
    outletName: x.outletName,
    externalOrderId: x.externalOrderId,
    status: x.status,
    customerName: x.customerName,
    guestReference: x.guestReference,
    reservationReference: x.reservationReference,
    roomNumber: x.roomNumber,
    items: (x.items || []).map((i) => ({ ...i, unitPrice: Number(i.unitPrice), lineTotal: money2(i.lineTotal) })),
    subtotal: money2(x.subtotal),
    serviceCharge: money2(x.serviceCharge),
    tax: money2(x.tax),
    discount: money2(x.discount),
    total: money2(x.total),
    currency: x.currency,
    orderedAt: x.orderedAt,
    posPaymentStatus: x.posPaymentStatus,
    posOrderStatus: x.posOrderStatus,
    matchIssues: x.matchIssues || [],
    reservation: r
      ? {
          id: r.id,
          reservationCode: r.reservationCode,
          status: r.status,
          roomNumber: r.room?.roomNumber ?? null,
          guestName: r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : null,
          guestId: r.guestId,
        }
      : null,
    stayId: x.matchedStayId,
    chargeId: x.stayChargeId,
    reviewedBy: x.reviewer ? userRef(x.reviewer) : x.reviewedBy ?? null,
    reviewedAt: x.reviewedAt,
    reviewNote: x.reviewNote,
    rejectionReason: x.rejectionReason,
    receivedAt: x.receivedAt,
    lastDeliveryAt: x.lastDeliveryAt,
    deliveryCount: x.deliveryCount,
    processingError: x.processingError,
    voidedAt: x.voidedAt,
    needsAdjustment: !!x.needsAdjustment,
    adjustmentResolvedBy: x.adjustmentResolver ? userRef(x.adjustmentResolver) : x.adjustmentResolvedBy ?? null,
    adjustmentResolvedAt: x.adjustmentResolvedAt,
  };
};
