/**
 * API-key authentication for external systems. Each system has its own key
 * (POS_API_KEY, RESERVATION_API_KEY) and can only reach its own endpoints.
 * Keys are compared as SHA-256 digests with a constant-time comparison.
 *
 * Send either   X-Api-Key: <key>   or   Authorization: Bearer <key>
 */
import crypto from "crypto";
import { config } from "../../config/index.js";
import { fail } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

const keyFor = (source) =>
  source === "POS" ? config.integrations.pos.apiKey : source === "RESERVATIONS" ? config.integrations.reservations.apiKey : "";

export const requireIntegrationKey = (source) => (req, res, next) => {
  const expected = keyFor(source);
  if (!expected) {
    return fail(res, 503, "INTEGRATION_DISABLED", `The ${source} integration is not configured on this PMS.`);
  }
  const header = req.get("authorization") || "";
  const presented = req.get("x-api-key") || (header.startsWith("Bearer ") ? header.slice(7) : "");
  if (!presented || !crypto.timingSafeEqual(digest(presented), digest(expected))) {
    logger.warn("integration_auth_failed", { source, ip: req.ip, path: req.originalUrl });
    return fail(res, 401, "INVALID_API_KEY", "Missing or invalid API key.");
  }
  req.integration = { source };
  next();
};
