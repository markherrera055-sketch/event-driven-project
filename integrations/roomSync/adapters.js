/**
 * Room sync adapters: the ONLY place that knows an external system's room API.
 *
 * Status (2026-11-21): neither OnlineBooking (StayBook) nor RoomCare has
 * published a room management API, so both adapters are CONTRACT PENDING.
 * They never send a request; jobs for them wait as BLOCKED and are re-queued
 * automatically once an adapter is implemented. No endpoint, field name or
 * auth scheme below is guessed — see docs/ROOM_SYNC.md §4 for exactly what each
 * team must provide.
 *
 * Adapter interface (implement when the contract arrives):
 *
 *   {
 *     target, label,
 *     ready: () => boolean,                 // true once create/update/deactivate are implemented
 *     missing: string[],                    // what is still needed (shown in the Admin Console)
 *     create(room, ctx)     → { externalRoomId, status, body }   // must honour ctx.idempotencyKey or
 *                                                                // be found by findByFrontdeskId (no duplicates)
 *     update(externalRoomId, room, ctx)     → { status, body }
 *     deactivate(externalRoomId, room, ctx) → { status, body }   // never a permanent delete
 *     findByFrontdeskId?(room, ctx) → externalRoomId | null       // optional duplicate guard before create
 *   }
 *
 *   room = roomSnapshot() from roomSyncService (Frontdesk canonical fields, snake_case)
 *   ctx  = { baseUrl, token, timeoutMs, idempotencyKey, operation }
 *
 * Use requestJson() from ./http.js for the HTTP call (timeouts, retry
 * classification, response capture). Throw ExternalApiError for failures.
 */
import { ROOM_SYNC_TARGETS } from "../../models/index.js";
import { ContractPendingError } from "./http.js";

const pending = (label) => async () => {
  throw new ContractPendingError(`${label} room API contract has not been provided yet; nothing was sent.`);
};

const contractPending = (target, label, missing) => ({
  target,
  label,
  contractPending: true,
  ready: () => false,
  missing,
  create: pending(label),
  update: pending(label),
  deactivate: pending(label),
});

/** OnlineBooking (StayBook, Member 1). Its documented API has no room endpoints and no server-to-server auth. */
const staybook = contractPending(ROOM_SYNC_TARGETS.STAYBOOK, "OnlineBooking (StayBook)", [
  "Server-to-server authentication (API key / bearer token header). Today StayBook only has session cookie + CSRF.",
  "Create room endpoint (method, path, request body, response with StayBook's room id).",
  "Update room endpoint addressed by StayBook room id (which fields may change: number, type, capacity, rate, description, amenities, active).",
  "Deactivate / unpublish room endpoint (or confirmation that update with an inactive flag is the supported way). No hard delete.",
  "Duplicate protection: Idempotency-Key support on create, or a lookup by Frontdesk room id.",
  "Field rules: room type values, name format, price/currency, amenities format, StayBook hotel id to send.",
  "Error format and which HTTP statuses are safe to retry.",
]);

/**
 * RoomCare. No API documentation exists in this project. UNVERIFIED ASSUMPTION: RoomCare is the
 * Housekeeping System (Member 3); the first item below asks Member 3 to confirm or correct that.
 */
const roomcare = contractPending(ROOM_SYNC_TARGETS.ROOMCARE, "RoomCare", [
  "Confirmation from Member 3 that RoomCare IS the Housekeeping System (same team, same HOUSEKEEPING_* credentials). Until confirmed this is an unverified assumption.",
  "RoomCare API documentation (base URL, authentication header and credential).",
  "Create room endpoint (request body, response with RoomCare's room id).",
  "Update room endpoint addressed by RoomCare room id, and the supported fields.",
  "Deactivate room endpoint or flag. No hard delete.",
  "Duplicate protection: Idempotency-Key support on create, or a lookup by Frontdesk room id.",
  "Confirmation that RoomCare accepts the existing RoomVacated webhook (docs/INTEGRATIONS.md §6) for cleaning tasks, or its own cleaning-task endpoint and payload.",
  "Confirmation that RoomCare reports status with the Frontdesk callbacks (cleaning-status / cleaning-started / cleaning-completed) and signs them with HOUSEKEEPING_INBOUND_SECRET.",
]);

const DEFAULTS = Object.freeze({ [staybook.target]: staybook, [roomcare.target]: roomcare });
let adapters = { ...DEFAULTS };

export const getAdapter = (target) => adapters[target] || null;
export const allAdapters = () => Object.values(adapters);

/** Replaces an adapter (used by the automated tests to simulate a receiving system). */
export function registerAdapter(adapter) {
  adapters = { ...adapters, [adapter.target]: adapter };
}
export function resetAdapters() {
  adapters = { ...DEFAULTS };
}
