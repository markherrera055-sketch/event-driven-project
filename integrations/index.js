/**
 * Integration layer entry point. Mounted at /api/v1/integrations BEFORE the
 * session/CSRF middleware: external systems authenticate with API keys only.
 *
 *   /api/v1/integrations/pos/*           → POS system           (POS_API_KEY)
 *   /api/v1/integrations/reservations/*  → Hotel Reservation System (RESERVATION_API_KEY)
 *
 * Each sub-router: rate limit → API-key auth → idempotency → handlers.
 */
import express from "express";
import { config } from "../config/index.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireIntegrationKey } from "./shared/apiKeyAuth.js";
import { idempotent } from "./shared/idempotency.js";
import { registerIntegrationSubscriptions } from "./shared/subscriptions.js";
import { startOutboxWorker } from "./shared/outbox.js";
import posRoutes from "./pos/routes.js";
import reservationRoutes from "./reservations/routes.js";

export function integrationRouter() {
  const router = express.Router();
  const limiter = (source) =>
    rateLimit({
      windowMs: 60_000,
      max: config.integrations.rateLimitPerMinute,
      key: (req) => `${source}:${req.ip}`,
    });

  router.use("/pos", limiter("POS"), requireIntegrationKey("POS"), idempotent, posRoutes);
  router.use("/reservations", limiter("RESERVATIONS"), requireIntegrationKey("RESERVATIONS"), idempotent, reservationRoutes);
  return router;
}

/** Wire domain events to the outbox and start webhook delivery. */
export function startIntegrations({ worker = true } = {}) {
  registerIntegrationSubscriptions();
  if (worker) startOutboxWorker();
}

/** Non-secret configuration status for the admin console. */
export const integrationStatus = () => ({
  pos: { enabled: !!config.integrations.pos.apiKey, webhookConfigured: !!config.integrations.pos.webhookUrl, signed: !!config.integrations.pos.webhookSecret },
  reservations: {
    enabled: !!config.integrations.reservations.apiKey,
    webhookConfigured: !!config.integrations.reservations.webhookUrl,
    signed: !!config.integrations.reservations.webhookSecret,
  },
  rateLimitPerMinute: config.integrations.rateLimitPerMinute,
});
