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
    isActive: x.isActive,
    archivedAt: x.archivedAt ?? null,
    needsCleaning: x.needsCleaning,
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
