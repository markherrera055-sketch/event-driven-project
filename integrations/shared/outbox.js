/**
 * Outbound webhooks via a transactional outbox.
 *
 *  enqueue()  — called inside the business transaction; writes a PENDING row.
 *  worker     — periodically delivers due rows with an HMAC-SHA256 signature,
 *               retrying with exponential backoff (30s, 1m, 2m … max 1h)
 *               until INTEGRATION_OUTBOX_MAX_ATTEMPTS, then FAILED.
 *               If the target has no webhook URL configured the row is SKIPPED.
 *
 * Signature (receivers should verify it):
 *   X-PMS-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *   X-PMS-Timestamp: <unix seconds>   X-PMS-Event: <eventType>   X-PMS-Delivery: <outbox id>
 */
import crypto from "crypto";
import { Op } from "sequelize";
import { IntegrationOutbox, OUTBOX_STATUS, OUTBOX_TARGETS } from "../../models/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const targetConfig = (target) =>
  target === OUTBOX_TARGETS.POS ? config.integrations.pos : config.integrations.reservations;

export const enqueue = (target, eventType, payload, transaction) =>
  IntegrationOutbox.create({ target, eventType, payload, status: OUTBOX_STATUS.PENDING, nextAttemptAt: new Date() }, { transaction });

export const signPayload = (secret, timestamp, rawBody) =>
  `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

async function deliver(row) {
  const { webhookUrl, webhookSecret } = targetConfig(row.target);
  if (!webhookUrl) {
    await row.update({ status: OUTBOX_STATUS.SKIPPED, lastError: "No webhook URL configured" });
    return;
  }
  const rawBody = JSON.stringify({ id: row.id, event: row.eventType, createdAt: row.createdAt, data: row.payload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "HotelFrontDeskPMS-Webhooks/1.0",
    "X-PMS-Event": row.eventType,
    "X-PMS-Delivery": String(row.id),
    "X-PMS-Timestamp": timestamp,
  };
  if (webhookSecret) headers["X-PMS-Signature"] = signPayload(webhookSecret, timestamp, rawBody);

  const attempts = row.attempts + 1;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(config.integrations.webhookTimeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await row.update({ status: OUTBOX_STATUS.SENT, attempts, sentAt: new Date(), lastError: null });
    logger.info("webhook_sent", { id: row.id, target: row.target, event: row.eventType });
  } catch (err) {
    const exhausted = attempts >= config.integrations.outboxMaxAttempts;
    await row.update({
      attempts,
      status: exhausted ? OUTBOX_STATUS.FAILED : OUTBOX_STATUS.PENDING,
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      lastError: String(err.message).slice(0, 500),
    });
    logger.warn("webhook_failed", { id: row.id, target: row.target, attempts, exhausted, error: err.message });
  }
}

let running = false;
/** Delivers all due events once (also used by tests and the admin "retry now" action). */
export async function processOutbox({ limit = 25 } = {}) {
  if (running) return 0;
  running = true;
  try {
    const due = await IntegrationOutbox.findAll({
      where: { status: OUTBOX_STATUS.PENDING, nextAttemptAt: { [Op.lte]: new Date() } },
      order: [["id", "ASC"]],
      limit,
    });
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
  return IntegrationOutbox.findAll({ where, order: [["id", "DESC"]], limit });
}

/** Re-queue a FAILED or SKIPPED event (admin action). */
export async function retryOutboxEvent(id) {
  const row = await IntegrationOutbox.findByPk(id);
  if (!row) return null;
  await row.update({ status: OUTBOX_STATUS.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null });
  return row;
}
