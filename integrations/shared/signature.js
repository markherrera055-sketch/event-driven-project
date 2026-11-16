/**
 * HMAC-SHA256 request signing, used in both directions:
 *   PMS → system  (webhooks)        X-PMS-Timestamp + X-PMS-Signature
 *   system → PMS  (inbound calls)   X-Timestamp     + X-Signature
 *
 *   signature = "sha256=" + hex( HMAC_SHA256(secret, `${timestamp}.${rawBody}`) )
 *
 * timestamp is Unix seconds. Including it in the signed text, and rejecting
 * timestamps outside the tolerance window, stops a captured request from
 * being replayed later.
 */
import crypto from "crypto";

export const signPayload = (secret, timestamp, rawBody) =>
  `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Returns null when valid, otherwise an error code:
 * SIGNATURE_REQUIRED | SIGNATURE_EXPIRED | INVALID_SIGNATURE
 */
export function verifySignature({ secret, timestamp, signature, rawBody, toleranceSeconds, now = Date.now() }) {
  if (!timestamp || !signature) return "SIGNATURE_REQUIRED";
  if (!/^\d{1,12}$/.test(String(timestamp))) return "INVALID_SIGNATURE";
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return "SIGNATURE_EXPIRED";
  return safeEqual(signPayload(secret, timestamp, rawBody ?? ""), signature) ? null : "INVALID_SIGNATURE";
}
