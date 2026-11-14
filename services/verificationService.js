/**
 * Identity Verification module (DFD 2.0, REQ-2): "The system shall record
 * each ID check and allow retry until verified."
 *
 * The receptionist inspects the physical ID and enters what it shows; the
 * system validates it against the reservation's guest and saves the attempt
 * (VERIFIED or FAILED, with reasons). Only the ID type and the last 4
 * characters of the ID number are stored.
 */
import { Reservation, IdentityVerification, RESERVATION_STATUS, VERIFICATION_RESULT } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { today } from "../utils/dates.js";
import { verificationJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

const normalise = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** The name on the ID must contain the guest's first and last name (any order, middle names allowed). */
export const nameMatches = (nameOnId, guest) => {
  const idTokens = new Set(normalise(nameOnId));
  const required = [...normalise(guest.firstName), ...normalise(guest.lastName)];
  return required.length > 0 && required.every((t) => idTokens.has(t));
};

/** IdentityVerification.verify(): evaluate, persist the attempt, return it. */
export async function verifyIdentity(reservationId, input, actor) {
  return withTransaction(null, async (t) => {
    const reservation = await Reservation.findByPk(reservationId, {
      include: ["guest"],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Reservation },
    });
    if (!reservation) throw notFound("Reservation");
    if (reservation.status !== RESERVATION_STATUS.CONFIRMED) {
      throw conflict("RESERVATION_NOT_AWAITING_ARRIVAL", `Reservation ${reservation.reservationCode} is ${reservation.status}; identity can only be verified before check-in.`);
    }

    const reasons = [];
    if (!nameMatches(input.nameOnId, reservation.guest)) reasons.push("Name on ID does not match the reservation guest");
    if (input.expiryDate && input.expiryDate < today()) reasons.push("ID is expired");
    if (!input.photoMatches) reasons.push("Photo on ID does not match the guest");

    const previous = (await IdentityVerification.max("attemptNo", { where: { reservationId }, transaction: t })) || 0;
    const attempt = await IdentityVerification.create(
      {
        reservationId,
        attemptNo: previous + 1,
        idType: input.idType,
        idNumberLast4: input.idNumberLast4.toUpperCase(),
        result: reasons.length ? VERIFICATION_RESULT.FAILED : VERIFICATION_RESULT.VERIFIED,
        failureReason: reasons.length ? reasons.join("; ") : null,
        verifiedBy: actor.id,
        attemptedAt: new Date(),
      },
      { transaction: t }
    );
    logger.info("identity_verification", { reservationId, attemptNo: attempt.attemptNo, result: attempt.result, by: actor.id });
    return verificationJSON(attempt);
  });
}

export async function listVerifications(reservationId) {
  const rows = await IdentityVerification.findAll({
    where: { reservationId },
    include: [{ association: "verifier", attributes: ["id", "fullName", "role"] }],
    order: [["attemptNo", "ASC"]],
  });
  return rows.map(verificationJSON);
}

/** VerificationGuard.isVerified(reservationId) — the latest attempt must be VERIFIED. */
export async function isVerified(reservationId, transaction) {
  const latest = await IdentityVerification.findOne({
    where: { reservationId },
    order: [["attemptNo", "DESC"]],
    transaction,
  });
  return latest?.result === VERIFICATION_RESULT.VERIFIED;
}
