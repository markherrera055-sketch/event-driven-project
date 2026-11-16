/**
 * Integration layer entry point — the PMS's API for the other hotel systems.
 * Mounted at /api/v1/integrations BEFORE the session / CSRF middleware:
 * external systems authenticate with their own API key only.
 *
 *   /booking/*        Guest Booking System    (Member 1)  reservations in, reservation status out
 *   /pos/*            Restaurant POS          (Member 4)  charges to a guest's room folio
 *   /housekeeping/*   Housekeeping System     (Member 3)  RoomVacated out, cleaning started / completed in
 *   /hr/*             HR and Payroll System   (Member 5)  read-only verification of housekeeping task records
 *
 * Pipeline for every request:
 *   HTTPS check → per-IP limit → API key (who is calling) → per-system limit
 *   → signature (systems with an inbound secret, writes) → Idempotency-Key (writes)
 *   → route: scope check (what the caller may do) → validation → service
 *
 * The core never imports this folder: core services raise domain events, and
 * subscriptions.js turns them into logged events and webhook deliveries.
 */
import express from "express";
import { config } from "../config/index.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { fail } from "../utils/http.js";
import { requireHttps, authenticate, requireSignedWrites } from "./shared/auth.js";
import { idempotent } from "./shared/idempotency.js";
import { registerIntegrationSubscriptions, subscribedEvents } from "./shared/subscriptions.js";
import { startOutboxWorker } from "./shared/outbox.js";
import { clientStatus } from "./shared/clients.js";
import bookingRoutes from "./booking/routes.js";
import posRoutes from "./pos/routes.js";
import housekeepingRoutes from "./housekeeping/routes.js";
import hrRoutes from "./hr/routes.js";

export function integrationRouter() {
  const router = express.Router();
  const perMinute = config.integrations.rateLimitPerMinute;
  // Before authentication: slows down key guessing from one address.
  const perIp = rateLimit({ windowMs: 60_000, max: perMinute * 4, key: (req) => `integration-ip:${req.ip}` });
  // After authentication: each system has its own budget.
  const perSystem = rateLimit({ windowMs: 60_000, max: perMinute, key: (req) => `integration:${req.integration.source}:${req.ip}` });

  router.use(requireHttps, perIp, authenticate, perSystem, requireSignedWrites, idempotent);
  router.use("/booking", bookingRoutes);
  router.use("/pos", posRoutes);
  router.use("/housekeeping", housekeepingRoutes);
  router.use("/hr", hrRoutes);
  // Never fall through to the staff API behind this router.
  router.use((req, res) => fail(res, 404, "NOT_FOUND", `No integration endpoint ${req.method} ${req.baseUrl}${req.path}`));
  return router;
}

/** Wire domain events to the event log / outbox and start webhook delivery. */
export function startIntegrations({ worker = true } = {}) {
  registerIntegrationSubscriptions();
  if (worker) startOutboxWorker();
}

/** Non-secret configuration status for the admin console. */
export const integrationStatus = () => ({
  clients: clientStatus().map((c) => ({ ...c, webhookEvents: subscribedEvents(c.source) })),
  rateLimitPerMinute: config.integrations.rateLimitPerMinute,
  requireHttps: config.integrations.requireHttps,
  signatureToleranceSeconds: config.integrations.signatureToleranceSeconds,
});
