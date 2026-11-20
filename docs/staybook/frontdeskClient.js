/**
 * Reference client: StayBook backend → Frontdesk / PMS.
 *
 * Written for the StayBook developer to copy into StayBook's SERVER code
 * (never the browser — it carries the API key). Node 18+ (global fetch), ES
 * modules; for CommonJS replace the `export` keywords with module.exports.
 *
 *   import { createFrontdeskClient, toFrontdeskReservation, syncOutcome } from "./frontdeskClient.js";
 *   const frontdesk = createFrontdeskClient({
 *     baseUrl: process.env.FRONTDESK_BASE_URL,   // e.g. https://frontdesk.example.com
 *     apiKey: process.env.FRONTDESK_API_KEY,     // the Frontdesk BOOKING_API_KEY, given privately
 *   });
 *   // right after StayBook saves / confirms a booking:
 *   const result = await frontdesk.createReservation(toFrontdeskReservation(row, { hotelId: row.hotel_id }));
 *   const outcome = syncOutcome(result);   // { sync_status: SYNCED | PENDING_RETRY | REJECTED, frontdesk_reservation_id, error_code }
 *   // store outcome on the StayBook booking (integration_status, frontdesk_reservation_id, last error code)
 *
 * Retry rules (agreed with the Frontdesk API):
 *  - Network errors, timeouts, 408 / 429 / 5xx and 409 REQUEST_IN_PROGRESS are retried here with
 *    exponential backoff, ALWAYS with the same Idempotency-Key and the same body, so a request that
 *    did reach the Frontdesk is never applied twice (the Frontdesk replays the stored answer).
 *  - Other 4xx are business answers (unmapped room, sold out, invalid data…). They are not retried:
 *    the outcome is REJECTED and StayBook staff must look at it. After the cause is fixed, retry with
 *    `generation + 1` (a new Idempotency-Key); the same key would replay the stored refusal.
 *  - If every attempt fails (Frontdesk unavailable) the outcome is PENDING_RETRY: keep the booking in
 *    a queue and call the same method again later with the same generation.
 */
import crypto from "crypto";

export const SYNC_STATUS = Object.freeze({ SYNCED: "SYNCED", PENDING_RETRY: "PENDING_RETRY", REJECTED: "REJECTED" });

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["REQUEST_IN_PROGRESS"]);
const KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;

/**
 * Deterministic Idempotency-Key for one logical operation on one booking revision.
 * Same inputs → same key, so automatic retries (and a later queued retry) reuse it.
 */
export function idempotencyKey(operation, bookingReference, revision, generation = 1) {
  const rev = revision instanceof Date ? revision.getTime() : Date.parse(revision) || String(revision ?? "0");
  const readable = `staybook:${operation}:${bookingReference}:${rev}:${generation}`;
  if (KEY_RE.test(readable)) return readable;
  return `staybook:${operation}:${crypto.createHash("sha256").update(readable).digest("hex").slice(0, 40)}`;
}

const iso = (value) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("A booking revision timestamp (updated_at) is required for synchronisation.");
  return d.toISOString();
};

/**
 * StayBook reservation row / confirm response (OnlineBooking API documentation,
 * "Confirm booking") → Frontdesk contract. Only the listed fields are sent:
 * no address, no payment method, no card digits.
 * `updated_at` must be the booking's real revision time (not "now"), so a retry sends the same body.
 */
export function toFrontdeskReservation(r, { hotelId } = {}) {
  return {
    source_system: "STAYBOOK",
    source_booking_id: String(r.reservation_id),
    booking_reference: r.reference,
    hotel_id: String(hotelId ?? r.hotel_id),
    staybook_room_id: String(r.room_id),
    guest: {
      first_name: r.first_name,
      last_name: r.last_name,
      ...(r.email ? { email: r.email } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
    },
    check_in: r.check_in,
    check_out: r.check_out,
    guests: Number(r.guests),
    nights: Number(r.nights),
    nightly_rate: Number(r.nightly_rate),
    total_amount: Number(r.total_amount),
    currency: r.currency || "PHP",
    booking_status: r.status, // LOCAL_CONFIRMED | ADMIN_CONFIRMED
    payment_mode: "SIMULATED", // StayBook payments are demo bookkeeping, never real money
    updated_at: iso(r.updated_at),
  };
}

/** Result of a call → what StayBook should record on the booking. */
export function syncOutcome(result) {
  if (result.ok) return { sync_status: SYNC_STATUS.SYNCED, frontdesk_reservation_id: result.data?.frontdesk_reservation_id ?? null, error_code: null };
  // Created earlier (e.g. the first answer was lost): the details carry the existing reservation.
  if (result.error?.code === "DUPLICATE_RESERVATION" && result.error.details?.frontdesk_reservation_id) {
    return { sync_status: SYNC_STATUS.SYNCED, frontdesk_reservation_id: result.error.details.frontdesk_reservation_id, error_code: null };
  }
  return {
    sync_status: result.retryable ? SYNC_STATUS.PENDING_RETRY : SYNC_STATUS.REJECTED,
    frontdesk_reservation_id: null,
    error_code: result.error?.code ?? null,
  };
}

export function createFrontdeskClient({
  baseUrl,
  apiKey,
  timeoutMs = 10_000,
  maxAttempts = 4,
  retryDelayMs = 1_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!baseUrl || !apiKey) throw new Error("Frontdesk base URL and API key are required (FRONTDESK_BASE_URL, FRONTDESK_API_KEY).");
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1/integrations/staybook`;

  async function call(method, path, { body, key } = {}) {
    const raw = body === undefined ? undefined : JSON.stringify(body); // identical bytes on every retry
    const headers = { Accept: "application/json", "X-Api-Key": apiKey };
    if (raw !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;

    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let wait = retryDelayMs * 2 ** (attempt - 1);
      try {
        const res = await fetchImpl(root + path, { method, headers, body: raw, signal: controller.signal });
        const json = await res.json().catch(() => null);
        const error = res.ok ? null : json?.error ?? { code: `HTTP_${res.status}`, message: `Frontdesk answered HTTP ${res.status}.` };
        const retryable = !res.ok && (RETRYABLE_HTTP.has(res.status) || RETRYABLE_CODES.has(error?.code));
        last = {
          ok: res.ok,
          status: res.status,
          data: json?.data ?? null,
          error,
          retryable,
          replayed: res.headers.get("idempotent-replayed") === "true",
          attempts: attempt,
          idempotencyKey: key ?? null,
        };
        if (!retryable) return last;
        const retryAfter = Number(res.headers.get("retry-after"));
        if (retryAfter > 0) wait = retryAfter * 1000;
      } catch (err) {
        last = {
          ok: false,
          status: 0,
          data: null,
          error: { code: err.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", message: "The Frontdesk could not be reached." },
          retryable: true,
          replayed: false,
          attempts: attempt,
          idempotencyKey: key ?? null,
        };
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await sleep(wait);
    }
    return last;
  }

  const ref = (idOrReference) => encodeURIComponent(String(idOrReference));

  return {
    /** Authoritative availability of the mapped rooms (check before confirming a booking). */
    availableRooms: ({ checkIn, checkOut, guests, hotelId }) => {
      const q = new URLSearchParams({ check_in: checkIn, check_out: checkOut, guests: String(guests) });
      if (hotelId !== undefined) q.set("hotel_id", String(hotelId));
      return call("GET", `/rooms/available?${q}`);
    },

    /** New booking. payload = toFrontdeskReservation(row). */
    createReservation: (payload, { generation = 1 } = {}) =>
      call("POST", "/reservations", { body: payload, key: idempotencyKey("create", payload.booking_reference, payload.updated_at, generation) }),

    /** Later revision: only changed fields + updated_at (required). */
    updateReservation: (bookingReference, changes, { generation = 1 } = {}) => {
      const body = { ...changes, updated_at: iso(changes.updated_at) };
      return call("PATCH", `/reservations/${ref(bookingReference)}`, { body, key: idempotencyKey("update", bookingReference, body.updated_at, generation) });
    },

    /** Cancellation (repeating it is harmless). */
    cancelReservation: (bookingReference, { reason, updatedAt, generation = 1 } = {}) => {
      const body = { ...(reason ? { reason } : {}), ...(updatedAt ? { updated_at: iso(updatedAt) } : {}) };
      return call("POST", `/reservations/${ref(bookingReference)}/cancel`, {
        body,
        key: idempotencyKey("cancel", bookingReference, updatedAt ?? 0, generation),
      });
    },

    /** Current Frontdesk state (by Frontdesk reservation id or StayBook booking reference). */
    getReservation: (idOrReference) => call("GET", `/reservations/${ref(idOrReference)}`),
  };
}
