/**
 * Webhook delivery from the transactional outbox (rows are written by
 * subscriptions.js inside the business transaction).
 *
 * Worker: claims due PENDING rows with SELECT … FOR UPDATE SKIP LOCKED (safe
 * with several app instances), POSTs each one signed with HMAC-SHA256, and
 * retries failures with exponential backoff (30 s, 1 min, 2 min … max 1 h)
 * until INTEGRATION_OUTBOX_MAX_ATTEMPTS, then marks the row FAILED. An
 * administrator can re-queue FAILED rows from the Admin Console.
 * Delivery is at-least-once: receivers de-duplicate on event_id.
 *
 * Headers:
 *   X-PMS-Event: <event name>        X-PMS-Event-Id: EVT-000042
 *   X-PMS-Delivery: <outbox id>      X-PMS-Timestamp: <unix seconds>
 *   X-PMS-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 */
import { Op, QueryTypes } from "sequelize";
import { sequelize, IntegrationOutbox, OUTBOX_STATUS, OUTBOX_TARGETS } from "../../models/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { clientSettings } from "./clients.js";
import { signPayload } from "./signature.js";
import { recordWebhookFailure } from "../staybook/staybookService.js";

export { signPayload };

const LEASE_MS = 2 * 60 * 1000;
export const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

async function deliver(row) {
  const { webhookUrl, webhookSecret } = clientSettings(row.target);
  if (!webhookUrl) {
    await row.update({ status: OUTBOX_STATUS.SKIPPED, lastError: "No webhook URL configured" });
    return;
  }
  const attempts = row.attempts + 1;
  if (config.isProduction && !webhookUrl.startsWith("https://")) {
    await row.update({ status: OUTBOX_STATUS.FAILED, attempts, lastError: "Webhook URL must use HTTPS in production" });
    return;
  }

  const rawBody = JSON.stringify(row.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "HotelFrontDeskPMS-Webhooks/2.0",
    "X-PMS-Event": row.eventType,
    "X-PMS-Event-Id": String(row.payload?.event_id ?? ""),
    "X-PMS-Delivery": String(row.id),
    "X-PMS-Timestamp": timestamp,
  };
  if (webhookSecret) headers["X-PMS-Signature"] = signPayload(webhookSecret, timestamp, rawBody);

  let status = null;
  let responseBody = null;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(config.integrations.webhookTimeoutMs),
    });
    status = response.status;
    // The receiver's answer (e.g. RoomCare's cleaning task id), kept for the admin console.
    responseBody = (await response.text().catch(() => "")).slice(0, 1000) || null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await row.update({ status: OUTBOX_STATUS.SENT, attempts, sentAt: new Date(), lastError: null, lastResponseStatus: status, lastResponseBody: responseBody });
    logger.info("webhook_sent", { id: row.id, target: row.target, event: row.eventType, eventId: row.payload?.event_id });
  } catch (err) {
    const exhausted = attempts >= config.integrations.outboxMaxAttempts;
    await row.update({
      attempts,
      status: exhausted ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING,
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      lastError: String(err.message).slice(0, 500),
      lastResponseStatus: status,
      lastResponseBody: responseBody,
    });
    logger.warn("webhook_failed", { id: row.id, target: row.target, attempts, exhausted, error: err.message });
    // StayBook bookings: tell the front desk that StayBook was not updated (Synchronization Failed).
    if (exhausted && row.target === OUTBOX_TARGETS.BOOKING) await recordWebhookFailure(row);
  }
}

/** Claims up to `limit` due rows; the lease keeps other workers away while this one delivers them. */
async function claimDue(limit) {
  return sequelize.transaction(async (t) => {
    const ids = (
      await sequelize.query(
        `SELECT id FROM integration_outbox WHERE status = :pending AND next_attempt_at <= :now
          ORDER BY id LIMIT :limit FOR UPDATE SKIP LOCKED`,
        { replacements: { pending: OUTBOX_STATUS.PENDING, now: new Date(), limit }, type: QueryTypes.SELECT, transaction: t }
      )
    ).map((r) => r.id);
    if (!ids.length) return [];
    await IntegrationOutbox.update({ nextAttemptAt: new Date(Date.now() + LEASE_MS) }, { where: { id: ids }, transaction: t });
    return IntegrationOutbox.findAll({ where: { id: ids }, order: [["id", "ASC"]], transaction: t });
  });
}

let running = false;
/** Delivers all due events once (also used by tests and the admin "retry" action). */
export async function processOutbox({ limit = 25 } = {}) {
  if (running) return 0;
  running = true;
  try {
    const due = await claimDue(limit);
    for (const row of due) await deliver(row);
    return due.length;
  } finally {
    running = false;
  }
}

let timer = null;
export function startOutboxWorker() {
  if (timer) return;
  timer = setInterval(() => processOutbox().catch((e) => logger.error("outbox_worker_error", { error: e.message })), config.integrations.outboxIntervalMs);
  timer.unref();
}
export function stopOutboxWorker() {
  clearInterval(timer);
  timer = null;
}

export async function listOutbox({ status, limit = 50 } = {}) {
  const where = status ? { status } : {};
  const rows = await IntegrationOutbox.findAll({ where, order: [["id", "DESC"]], limit });
  return rows.map((r) => ({
    id: r.id,
    target: r.target,
    eventType: r.eventType,
    eventId: r.payload?.event_id ?? null,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    lastResponseStatus: r.lastResponseStatus,
    lastResponseBody: r.lastResponseBody,
    nextAttemptAt: r.nextAttemptAt,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
  }));
}

/** Re-queue an event (admin action). A delivered event can be re-sent: receivers de-duplicate on event_id. */
export async function retryOutboxEvent(id) {
  const row = await IntegrationOutbox.findByPk(id);
  if (!row) return null;
  await row.update({ status: OUTBOX_STATUS.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null });
  return row;
}

/**
 * Webhook delivery health of one receiving system, from real deliveries:
 * NOT_CONFIGURED (no URL) · UNKNOWN (nothing delivered yet) · CONNECTED (last attempt 2xx) · ERROR.
 */
export async function outboxHealth(target) {
  const configured = !!clientSettings(target).webhookUrl;
  const [last, lastSent, pending, failed] = await Promise.all([
    IntegrationOutbox.findOne({ where: { target, attempts: { [Op.gt]: 0 } }, order: [["updatedAt", "DESC"], ["id", "DESC"]] }),
    IntegrationOutbox.max("sentAt", { where: { target } }),
    IntegrationOutbox.count({ where: { target, status: OUTBOX_STATUS.PENDING } }),
    IntegrationOutbox.count({ where: { target, status: OUTBOX_STATUS.FAILED } }),
  ]);
  let connection = "UNKNOWN";
  if (!configured) connection = "NOT_CONFIGURED";
  else if (last) connection = last.status === OUTBOX_STATUS.SENT ? "CONNECTED" : "ERROR";
  return {
    target,
    configured,
    connection,
    lastSuccessAt: lastSent ?? null,
    lastAttemptAt: last?.updatedAt ?? null,
    lastError: last && last.status !== OUTBOX_STATUS.SENT ? last.lastError : null,
    pending,
    failed,
  };
}
