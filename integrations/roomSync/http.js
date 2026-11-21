/**
 * Outbound JSON requests to OnlineBooking / RoomCare (used by the adapters in
 * adapters.js). Contract-neutral: it knows nothing about either API's paths,
 * fields or authentication scheme — the adapter supplies those.
 *
 *   - every request has a timeout (ROOM_SYNC_TIMEOUT_MS, default 10 s)
 *   - HTTPS is required in production
 *   - failures become ExternalApiError with `retryable`:
 *       network error, timeout, 408, 425, 429, 5xx  → retryable (backoff)
 *       other 4xx                                    → permanent (job FAILED, admin decides)
 *   - the answer's first 1000 characters are kept for the admin console
 */
import { config } from "../../config/index.js";

export class ExternalApiError extends Error {
  constructor(message, { status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = "ExternalApiError";
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/** Thrown by an adapter whose API contract has not been provided / implemented. Nothing is sent. */
export class ContractPendingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractPendingError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429]);
export const isRetryableStatus = (status) => status >= 500 || RETRYABLE_STATUS.has(status);
export const truncate = (text, max = 1000) => (text == null ? null : String(text).slice(0, max));

/**
 * requestJson({ method, url, headers, body, timeoutMs }) → { status, body (parsed JSON or text), raw }
 */
export async function requestJson({ method = "GET", url, headers = {}, body, timeoutMs = config.integrations.roomSync.timeoutMs }) {
  if (config.isProduction && !String(url).startsWith("https://")) {
    throw new ExternalApiError("External API URL must use HTTPS in production", { retryable: false });
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": "HotelFrontDeskPMS-RoomSync/1.0",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new ExternalApiError(timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${err.cause?.code || err.message}`, { retryable: true });
  }
  const raw = await response.text().catch(() => "");
  let parsed = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // not JSON: keep the text
  }
  if (!response.ok) {
    throw new ExternalApiError(`HTTP ${response.status}`, { status: response.status, retryable: isRetryableStatus(response.status), body: truncate(raw) });
  }
  return { status: response.status, body: parsed, raw: truncate(raw) };
}
