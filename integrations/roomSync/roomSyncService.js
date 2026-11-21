/**
 * Room catalogue synchronisation: Frontdesk → OnlineBooking (StayBook) and RoomCare.
 *
 *   Admin creates / edits / deletes / restores a room (services/roomService.js)
 *     └─ same DB transaction: RoomCreated | RoomUpdated | RoomArchived | RoomRestored
 *          └─ onRoomCatalogEvent(): one room_sync_jobs row per ENABLED target
 *             (an open job for the same room + target is re-used: edits coalesce)
 *   Worker (every ROOM_SYNC_INTERVAL_MS, also on admin retry)
 *     └─ claims due PENDING jobs (FOR UPDATE SKIP LOCKED + lease, safe with several instances)
 *          ├─ target not configured / adapter contract pending → BLOCKED (nothing sent)
 *          ├─ reads the room's CURRENT state (roomSnapshot)
 *          ├─ no mapping yet → adapter.create (stable Idempotency-Key per room + target)
 *          │                    → external id stored in external_room_mappings
 *          ├─ mapped        → adapter.update(externalRoomId)
 *          └─ archived room → adapter.deactivate(externalRoomId) (never a hard delete)
 *     success → SYNCED · retryable failure → PENDING with backoff · 4xx / exhausted → FAILED
 *
 * Targets fail independently: each has its own job, and an outage of one never
 * blocks the other or the Frontdesk transaction that caused the change.
 */
import { Op, QueryTypes, UniqueConstraintError, fn, col } from "sequelize";
import {
  sequelize,
  Room,
  RoomType,
  RoomSyncJob,
  ExternalRoomMapping,
  ROOM_SYNC_STATUS as S,
  ROOM_SYNC_TARGETS,
  OPEN_ROOM_SYNC_STATUSES,
  occupancyStatusOf,
} from "../../models/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { conflict, notFound } from "../../utils/errors.js";
import { subscribe, EVENTS, ROOM_CATALOG_EVENTS } from "../../services/domainEvents.js";
import { getAdapter, allAdapters } from "./adapters.js";
import { ExternalApiError, ContractPendingError, truncate } from "./http.js";

const LEASE_MS = 2 * 60 * 1000;
export const backoffMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

export const OPERATION = Object.freeze({ UPSERT: "UPSERT", CREATE: "CREATE", UPDATE: "UPDATE", DEACTIVATE: "DEACTIVATE" });
const URL_VARIABLE = Object.freeze({ STAYBOOK: "STAYBOOK_API_URL", ROOMCARE: "ROOMCARE_API_URL" });
const TRIGGER = Object.freeze({
  [EVENTS.ROOM_CREATED]: "CREATED",
  [EVENTS.ROOM_UPDATED]: "UPDATED",
  [EVENTS.ROOM_ARCHIVED]: "ARCHIVED",
  [EVENTS.ROOM_RESTORED]: "RESTORED",
});

export const targetSettings = (target) => config.integrations.roomSync.targets[target] || {};
export const isConfigured = (target) => !!targetSettings(target).baseUrl;
export const isReady = (target) => isConfigured(target) && !!getAdapter(target)?.ready();
export const enabledTargets = () => Object.values(ROOM_SYNC_TARGETS).filter(isConfigured);

/** Why a target cannot send yet (null when it can). */
function blockedReason(target) {
  if (!isConfigured(target)) return `${URL_VARIABLE[target] || `${target}_API_URL`} is not set.`;
  const adapter = getAdapter(target);
  if (!adapter?.ready()) return `${adapter?.label || target} room API contract is not implemented yet; nothing was sent.`;
  return null;
}

export const createKey = (roomId, target) => `frontdesk:room:${roomId}:${target.toLowerCase()}:create`;
const changeKey = (job) => `frontdesk:room:${job.roomId}:${job.target.toLowerCase()}:job${job.id}.v${job.version}`;

const mergeTrigger = (previous, next) => {
  const merged = previous ? `${previous}; ${next}` : next;
  return merged.length > 200 ? `…${merged.slice(-199)}` : merged;
};
const triggerText = (eventType, payload) => `${TRIGGER[eventType] || eventType}${payload.changes?.length ? `(${payload.changes.join(",")})` : ""}`;

/** The Frontdesk's canonical room record, as handed to every adapter (snake_case, no guest data). */
export async function roomSnapshot(room, transaction) {
  const type = await RoomType.findOne({ where: { name: room.roomType }, attributes: ["id"], transaction });
  return {
    frontdesk_room_id: room.id,
    room_number: room.roomNumber,
    room_type: room.roomType,
    room_type_id: type?.id ?? null,
    floor: room.floor ?? null,
    capacity: room.capacity,
    nightly_rate: Number(room.nightlyRate),
    currency: config.hotel.currency,
    description: room.description ?? null,
    amenities: Array.isArray(room.amenities) ? room.amenities : [],
    status: room.status,
    occupancy_status: occupancyStatusOf(room.status),
    is_active: !!room.isActive && !room.archivedAt,
    archived: !!room.archivedAt,
    updated_at: room.updatedAt,
  };
}

/**
 * Queues "bring <target> up to date for this room" inside the caller's
 * transaction. Re-uses the open PENDING / BLOCKED job (bumping its version so
 * an in-flight send of the older state is followed by another one); an older
 * FAILED job is marked SUPERSEDED.
 */
export async function enqueueRoomSync(room, target, trigger, { transaction, actorId = null } = {}) {
  const open = await RoomSyncJob.findAll({
    where: { roomId: room.id, target, status: OPEN_ROOM_SYNC_STATUSES },
    order: [["id", "DESC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const live = open.find((j) => j.status !== S.FAILED);
  for (const old of open) if (old !== live) await old.update({ status: S.SUPERSEDED }, { transaction });

  const reason = blockedReason(target);
  const values = {
    roomNumber: room.roomNumber,
    operation: room.archivedAt ? OPERATION.DEACTIVATE : OPERATION.UPSERT,
    status: reason ? S.BLOCKED : S.PENDING,
    lastError: reason,
    nextAttemptAt: new Date(),
  };
  if (live) {
    await live.update(
      { ...values, trigger: mergeTrigger(live.trigger, trigger), version: live.version + 1, requestedBy: actorId ?? live.requestedBy, lastError: reason ?? live.lastError },
      { transaction }
    );
    return live;
  }
  return RoomSyncJob.create(
    { ...values, roomId: room.id, target, trigger, idempotencyKey: createKey(room.id, target), requestedBy: actorId },
    { transaction }
  );
}

/** Domain event subscriber (registered at start-up). */
async function onRoomCatalogEvent(eventType, payload, { transaction }) {
  if (!ROOM_CATALOG_EVENTS.includes(eventType)) return;
  const targets = enabledTargets();
  if (!targets.length || !payload?.room_id) return;
  const run = async (t) => {
    const room = await Room.findByPk(payload.room_id, { transaction: t });
    if (!room) return;
    for (const target of targets) await enqueueRoomSync(room, target, triggerText(eventType, payload), { transaction: t, actorId: payload.changed_by });
  };
  await (transaction ? run(transaction) : sequelize.transaction(run));
}

let registered = false;
export function registerRoomSync() {
  if (registered) return;
  registered = true;
  subscribe(onRoomCatalogEvent);
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** Stores the external id; a clash with another Frontdesk room is a permanent failure. */
async function saveMapping(target, roomId, externalRoomId) {
  try {
    await ExternalRoomMapping.create({ sourceSystem: target, externalRoomId, roomId, createdBy: null });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const existing = await ExternalRoomMapping.findOne({ where: { sourceSystem: target, roomId } });
    if (existing?.externalRoomId === externalRoomId) return;
    throw new ExternalApiError(
      existing
        ? `Room is already mapped to ${target} room ${existing.externalRoomId}, but ${target} returned ${externalRoomId}. Check for a duplicate in ${target}.`
        : `${target} room ${externalRoomId} is already mapped to another Frontdesk room. Check for a duplicate in ${target}.`,
      { retryable: false }
    );
  }
}

const bodyText = (body) => truncate(typeof body === "string" ? body : body == null ? null : JSON.stringify(body));

/**
 * Writes the outcome, unless the room changed while the job was being sent
 * (version bumped by enqueueRoomSync): then the job stays PENDING so the newer
 * state goes out next, keeping what was learned (mapping, response).
 */
async function finish(job, claimedVersion, values) {
  const [count] = await RoomSyncJob.update({ ...values, lockedUntil: null }, { where: { id: job.id, version: claimedVersion } });
  if (count === 1) return;
  await RoomSyncJob.update(
    { ...values, lockedUntil: null, status: values.status === S.BLOCKED ? S.BLOCKED : S.PENDING, nextAttemptAt: new Date() },
    { where: { id: job.id } }
  );
}

async function send(job) {
  const claimedVersion = job.version;
  const reason = blockedReason(job.target);
  if (reason) return finish(job, claimedVersion, { status: S.BLOCKED, lastError: reason });

  const room = await Room.findByPk(job.roomId);
  if (!room) return finish(job, claimedVersion, { status: S.SUPERSEDED, lastError: "The room no longer exists in the Frontdesk; nothing to synchronise." });

  const adapter = getAdapter(job.target);
  const settings = targetSettings(job.target);
  const mapping = await ExternalRoomMapping.findOne({ where: { sourceSystem: job.target, roomId: room.id } });
  const snapshot = await roomSnapshot(room);
  const operation = room.archivedAt ? OPERATION.DEACTIVATE : mapping ? OPERATION.UPDATE : OPERATION.CREATE;

  if (operation === OPERATION.DEACTIVATE && !mapping) {
    return finish(job, claimedVersion, {
      status: S.SYNCED,
      operation,
      syncedAt: new Date(),
      lastError: null,
      lastResponseStatus: null,
      lastResponseBody: `Not sent: the room was never created in ${adapter.label}.`,
    });
  }

  const attempts = job.attempts + 1;
  const idempotencyKey = operation === OPERATION.CREATE ? createKey(room.id, job.target) : changeKey(job);
  await job.update({ attempts, lastAttemptAt: new Date(), operation, idempotencyKey });
  const ctx = { baseUrl: settings.baseUrl, token: settings.token, timeoutMs: config.integrations.roomSync.timeoutMs, idempotencyKey, operation };

  try {
    let result;
    let externalRoomId = mapping?.externalRoomId ?? null;
    if (operation === OPERATION.CREATE) {
      // Duplicate guard: a record created by an earlier attempt whose answer was lost.
      const found = adapter.findByFrontdeskId ? await adapter.findByFrontdeskId(snapshot, ctx) : null;
      if (found) {
        externalRoomId = String(found);
        await saveMapping(job.target, room.id, externalRoomId);
        result = await adapter.update(externalRoomId, snapshot, ctx);
      } else {
        result = await adapter.create(snapshot, ctx);
        if (!result?.externalRoomId) {
          throw new ExternalApiError(`${adapter.label} did not return its room id.`, { status: result?.status ?? null, retryable: false, body: bodyText(result?.body) });
        }
        externalRoomId = String(result.externalRoomId);
        await saveMapping(job.target, room.id, externalRoomId);
      }
    } else if (operation === OPERATION.UPDATE) {
      result = await adapter.update(externalRoomId, snapshot, ctx);
    } else {
      result = await adapter.deactivate(externalRoomId, snapshot, ctx);
    }
    await finish(job, claimedVersion, {
      status: S.SYNCED,
      syncedAt: new Date(),
      externalRoomId,
      lastError: null,
      lastResponseStatus: result?.status ?? null,
      lastResponseBody: bodyText(result?.body),
    });
    logger.info("room_sync_sent", { job: job.id, target: job.target, roomId: room.id, operation, externalRoomId });
  } catch (err) {
    if (err instanceof ContractPendingError) {
      // Nothing was sent: the attempt does not count.
      return finish(job, claimedVersion, { status: S.BLOCKED, attempts: attempts - 1, lastError: err.message });
    }
    const retryable = err instanceof ExternalApiError ? err.retryable : true;
    const exhausted = attempts >= config.integrations.roomSync.maxAttempts;
    await finish(job, claimedVersion, {
      status: retryable && !exhausted ? S.PENDING : S.FAILED,
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      lastError: truncate(err.message, 500),
      lastResponseStatus: err.status ?? null,
      lastResponseBody: err.body ?? null,
    });
    logger.warn("room_sync_failed", { job: job.id, target: job.target, roomId: room.id, operation, attempts, retryable, exhausted, error: err.message });
  }
}

/** BLOCKED jobs whose target has become ready (URL set, adapter implemented) go back in the queue. */
async function requeueUnblocked() {
  const ready = Object.values(ROOM_SYNC_TARGETS).filter(isReady);
  if (!ready.length) return 0;
  const [count] = await RoomSyncJob.update(
    { status: S.PENDING, lastError: null, nextAttemptAt: new Date() },
    { where: { status: S.BLOCKED, target: ready } }
  );
  return count;
}

async function claimDue(limit) {
  return sequelize.transaction(async (t) => {
    const now = new Date();
    const ids = (
      await sequelize.query(
        `SELECT id FROM room_sync_jobs
          WHERE status = :pending AND next_attempt_at <= :now AND (locked_until IS NULL OR locked_until < :now)
          ORDER BY id LIMIT :limit FOR UPDATE SKIP LOCKED`,
        { replacements: { pending: S.PENDING, now, limit }, type: QueryTypes.SELECT, transaction: t }
      )
    ).map((r) => r.id);
    if (!ids.length) return [];
    await RoomSyncJob.update({ lockedUntil: new Date(now.getTime() + LEASE_MS) }, { where: { id: ids }, transaction: t });
    return RoomSyncJob.findAll({ where: { id: ids }, order: [["id", "ASC"]], transaction: t });
  });
}

let running = false;
/** Sends all due jobs once (worker tick; also used by tests and the admin retry). */
export async function processRoomSync({ limit = 25 } = {}) {
  if (running) return 0;
  running = true;
  try {
    await requeueUnblocked();
    const due = await claimDue(limit);
    for (const job of due) {
      try {
        await send(job);
      } catch (err) {
        // Unexpected (e.g. database) error: release the lease so the job is retried later.
        logger.error("room_sync_error", { job: job.id, error: err.message });
        await RoomSyncJob.update({ lockedUntil: null, nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts + 1)) }, { where: { id: job.id } });
      }
    }
    return due.length;
  } finally {
    running = false;
  }
}

let timer = null;
export function startRoomSyncWorker() {
  if (timer) return;
  timer = setInterval(() => processRoomSync().catch((e) => logger.error("room_sync_worker_error", { error: e.message })), config.integrations.roomSync.intervalMs);
  timer.unref();
}
export function stopRoomSyncWorker() {
  clearInterval(timer);
  timer = null;
}

// ── Admin Console ───────────────────────────────────────────────────────────

export const jobJSON = (j) => ({
  id: j.id,
  roomId: j.roomId,
  roomNumber: j.roomNumber,
  target: j.target,
  operation: j.operation,
  trigger: j.trigger,
  status: j.status,
  version: j.version,
  attempts: j.attempts,
  externalRoomId: j.externalRoomId,
  idempotencyKey: j.idempotencyKey,
  lastError: j.lastError,
  lastResponseStatus: j.lastResponseStatus,
  lastResponseBody: j.lastResponseBody,
  nextAttemptAt: j.nextAttemptAt,
  lastAttemptAt: j.lastAttemptAt,
  syncedAt: j.syncedAt,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
});

export async function listRoomSyncJobs({ target, status, roomId, limit = 50 } = {}) {
  const where = {};
  if (target) where.target = target;
  if (status) where.status = status;
  if (roomId) where.roomId = roomId;
  return (await RoomSyncJob.findAll({ where, order: [["id", "DESC"]], limit })).map(jobJSON);
}

/**
 * Connection status per target, derived from real traffic (no request is
 * invented to "ping" an API whose contract is unknown):
 *   NOT_CONFIGURED · AWAITING_CONTRACT · UNKNOWN (no request yet) · CONNECTED · ERROR
 */
export async function roomSyncOverview() {
  const activeRooms = await Room.count({ where: { archivedAt: null } });
  const targets = [];
  for (const adapter of allAdapters()) {
    const target = adapter.target;
    const [counts, lastSuccessAt, lastAttempt, mappedRooms] = await Promise.all([
      RoomSyncJob.findAll({ where: { target }, attributes: ["status", [fn("COUNT", col("id")), "n"]], group: ["status"], raw: true }),
      RoomSyncJob.max("syncedAt", { where: { target } }),
      RoomSyncJob.findOne({ where: { target, lastAttemptAt: { [Op.ne]: null } }, order: [["lastAttemptAt", "DESC"]] }),
      ExternalRoomMapping.count({ where: { sourceSystem: target } }),
    ]);
    const byStatus = Object.fromEntries(Object.values(S).map((s) => [s, 0]));
    for (const c of counts) byStatus[c.status] = Number(c.n);

    let connection = "UNKNOWN";
    const lastOk = lastAttempt && lastAttempt.status === S.SYNCED && lastAttempt.syncedAt >= lastAttempt.lastAttemptAt;
    if (!isConfigured(target)) connection = "NOT_CONFIGURED";
    else if (!adapter.ready()) connection = "AWAITING_CONTRACT";
    else if (lastAttempt) connection = lastOk ? "CONNECTED" : "ERROR";

    targets.push({
      target,
      label: adapter.label,
      configured: isConfigured(target),
      urlVariable: URL_VARIABLE[target] || null,
      contractReady: !!adapter.ready(),
      missing: adapter.ready() ? [] : adapter.missing || [],
      connection,
      lastSuccessAt: lastSuccessAt ?? null,
      lastAttemptAt: lastAttempt?.lastAttemptAt ?? null,
      lastError: lastOk ? null : lastAttempt?.lastError ?? null,
      counts: byStatus,
      mappedRooms,
      activeRooms,
    });
  }
  return { targets, maxAttempts: config.integrations.roomSync.maxAttempts };
}

/** Admin: send a FAILED or BLOCKED job again (its room's current state). */
export async function retryRoomSyncJob(id) {
  const job = await RoomSyncJob.findByPk(id);
  if (!job) throw notFound("Room sync job");
  if (![S.FAILED, S.BLOCKED].includes(job.status)) {
    throw conflict("ROOM_SYNC_NOT_RETRYABLE", `Job ${id} is ${job.status}. Only FAILED or BLOCKED jobs can be retried; use "Sync all rooms" to re-send synced rooms.`);
  }
  const reason = blockedReason(job.target);
  await job.update({ status: reason ? S.BLOCKED : S.PENDING, attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, lastError: reason });
  if (!reason) await processRoomSync();
  return jobJSON(await job.reload());
}

/**
 * Admin: queue every room for one target (first connection, or after fixing
 * data on the other side). In-service rooms are upserted; deleted (archived)
 * rooms are deactivated only if the target knows them.
 */
export async function resyncAllRooms(target, actor) {
  if (!Object.values(ROOM_SYNC_TARGETS).includes(target)) throw notFound("Room sync target");
  if (!isConfigured(target)) throw conflict("ROOM_SYNC_NOT_CONFIGURED", `${URL_VARIABLE[target]} is not set on this server.`);
  const mappedIds = new Set((await ExternalRoomMapping.findAll({ where: { sourceSystem: target }, attributes: ["roomId"] })).map((m) => m.roomId));
  const rooms = (await Room.findAll({ attributes: ["id", "archivedAt"], order: [["id", "ASC"]] })).filter((r) => !r.archivedAt || mappedIds.has(r.id));
  for (const { id } of rooms) {
    await sequelize.transaction(async (transaction) => {
      const room = await Room.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (room) await enqueueRoomSync(room, target, "MANUAL_RESYNC", { transaction, actorId: actor?.id ?? null });
    });
  }
  logger.info("room_sync_resync", { target, rooms: rooms.length, by: actor?.id });
  if (isReady(target)) await processRoomSync();
  return { target, queued: rooms.length, blocked: blockedReason(target) };
}
