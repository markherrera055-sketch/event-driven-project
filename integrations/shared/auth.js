/**
 * Security middleware for /api/v1/integrations (mounted before the staff
 * session / CSRF middleware — external systems never use cookies).
 *
 *   requireHttps        refuse plain HTTP when INTEGRATION_REQUIRE_HTTPS (default on in production)
 *   authenticate        API key → which system is calling (X-Api-Key or Authorization: Bearer)
 *   requireSignedWrites HMAC signature + timestamp window on writes, for systems with an inbound secret;
 *                       systems that MUST sign (Housekeeping) get 503 on writes while their secret is missing
 *   requireScope(s)     the calling system must hold scope s (per-route authorization)
 */
import crypto from "crypto";
import { config } from "../../config/index.js";
import { fail } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import { CLIENTS, clientSettings, signingSecretMissing } from "./clients.js";
import { verifySignature } from "./signature.js";

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

export const requireHttps = (req, res, next) => {
  if (config.integrations.requireHttps && !req.secure) {
    return fail(res, 403, "HTTPS_REQUIRED", "Integration endpoints are only available over HTTPS.");
  }
  next();
};

/**
 * Identifies the calling system from its API key. Every configured key is
 * compared (as SHA-256 digests, in constant time, without stopping at the
 * first match) so response timing does not reveal which keys exist.
 */
export const authenticate = (req, res, next) => {
  const header = req.get("authorization") || "";
  const presented = req.get("x-api-key") || (header.startsWith("Bearer ") ? header.slice(7).trim() : "");
  let source = null;
  if (presented) {
    const presentedDigest = digest(presented);
    for (const name of Object.keys(CLIENTS)) {
      const key = clientSettings(name).apiKey;
      if (key && crypto.timingSafeEqual(presentedDigest, digest(key)) && !source) source = name;
    }
  }
  if (!source) {
    logger.warn("integration_auth_failed", { ip: req.ip, path: req.originalUrl, keyPresented: !!presented });
    return fail(res, 401, "INVALID_API_KEY", "Missing or invalid API key.");
  }
  req.integration = { source, scopes: CLIENTS[source].scopes };
  next();
};

/**
 * When the calling system has an inbound secret, every write must be signed (see signature.js).
 * A system that must sign (CLIENTS[x].inboundSigningRequired) but has no secret configured is
 * refused outright (fail closed) — except under NODE_ENV=test (config.integrations.enforceRequiredSigning).
 */
export const requireSignedWrites = (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const { source } = req.integration;
  const secret = clientSettings(source).inboundSecret;
  if (!secret && signingSecretMissing(source)) {
    logger.error("integration_signing_secret_missing", { source, path: req.originalUrl, variable: `${source}_INBOUND_SECRET` });
    return fail(
      res,
      503,
      "INBOUND_SIGNING_NOT_CONFIGURED",
      "Signed requests are required for this system, but the PMS has no signing secret configured for it. Writes are refused until the PMS administrator configures it."
    );
  }
  if (!secret) return next();
  const error = verifySignature({
    secret,
    timestamp: req.get("x-timestamp"),
    signature: req.get("x-signature"),
    rawBody: req.rawBody,
    toleranceSeconds: config.integrations.signatureToleranceSeconds,
  });
  if (error) {
    logger.warn("integration_signature_rejected", { source: req.integration.source, ip: req.ip, path: req.originalUrl, error });
    const messages = {
      SIGNATURE_REQUIRED: "This system must sign its requests: send X-Timestamp and X-Signature headers.",
      SIGNATURE_EXPIRED: `X-Timestamp is outside the allowed window of ${config.integrations.signatureToleranceSeconds} seconds.`,
      INVALID_SIGNATURE: "The request signature is not valid.",
    };
    return fail(res, 401, error, messages[error]);
  }
  next();
};

export const requireScope = (scope) => (req, res, next) => {
  if (!req.integration?.scopes.includes(scope)) {
    logger.warn("integration_scope_denied", { source: req.integration?.source, scope, path: req.originalUrl });
    return fail(res, 403, "INSUFFICIENT_SCOPE", `This API key is not allowed to perform this operation (requires ${scope}).`);
  }
  next();
};
