/**
 * Idempotency for integration write requests (POST / PATCH / PUT / DELETE).
 *
 * Clients must send `Idempotency-Key: <unique value per logical operation>`.
 *  - First request: processed normally; the final response is stored.
 *  - Retry with the same key and the same body: the stored response is
 *    returned unchanged with header `Idempotent-Replayed: true`.
 *  - Same key with a different body: 422 IDEMPOTENCY_KEY_REUSED.
 *  - Same key while the first request is still running: 409 REQUEST_IN_PROGRESS.
 * Server errors (5xx) are not stored, so the client can safely retry them.
 *
 * Every accepted request is therefore also logged in integration_requests.
 */
import crypto from "crypto";
import { UniqueConstraintError } from "sequelize";
import { IntegrationRequest } from "../../models/index.js";
import { fail } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";

const KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
};

export const idempotent = (req, res, next) => {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return next();
  const key = req.get("idempotency-key");
  if (!key || !KEY_RE.test(key)) {
    return fail(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (8-100 characters: letters, digits, . _ : -).");
  }
  const source = req.integration.source;
  const path = req.originalUrl.split("?")[0].slice(0, 255);
  const requestHash = crypto
    .createHash("sha256")
    .update(`${req.method} ${path} ${JSON.stringify(canonical(req.body || {}))}`)
    .digest("hex");

  (async () => {
    let record;
    try {
      record = await IntegrationRequest.create({ source, idempotencyKey: key, method: req.method, path, requestHash });
    } catch (err) {
      if (!(err instanceof UniqueConstraintError)) throw err;
      const existing = await IntegrationRequest.findOne({ where: { source, idempotencyKey: key } });
      if (!existing) return fail(res, 409, "REQUEST_IN_PROGRESS", "Retry shortly.");
      if (existing.requestHash !== requestHash) {
        return fail(res, 422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request.");
      }
      if (existing.responseStatus === null) {
        return fail(res, 409, "REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still being processed.");
      }
      res.set("Idempotent-Replayed", "true");
      return res.status(existing.responseStatus).json(existing.responseBody);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      const save =
        status >= 500
          ? IntegrationRequest.destroy({ where: { id: record.id } })
          : record.update({ responseStatus: status, responseBody: body });
      save.catch((e) => logger.error("idempotency_store_failed", { id: record.id, error: e.message }));
      logger.info("integration_request", { source, method: req.method, path, status, idempotencyKey: key });
      return originalJson(body);
    };
    next();
  })().catch(next);
};
