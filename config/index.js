/**
 * Central configuration. Every secret / environment-specific value is read
 * from environment variables (optionally loaded from a .env file).
 * Nothing sensitive is hardcoded here — only safe development defaults.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env without an extra dependency (Node >= 20.12 provides loadEnvFile).
// Variables already present in the environment are NOT overridden.
const envFile = process.env.ENV_FILE || path.join(rootDir, ".env");
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const env = process.env.NODE_ENV || "development";
const isProduction = env === "production";

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) =>
  value === undefined ? fallback : ["1", "true", "yes", "on"].includes(String(value).toLowerCase());

const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Settings of one external system, read from <PREFIX>_* variables. A legacy
 * prefix (e.g. RESERVATION_* for the booking system) is used as a fallback so
 * existing .env files keep working.
 */
function integrationClient(prefix, legacyPrefix) {
  const read = (name) => process.env[`${prefix}_${name}`] || (legacyPrefix && process.env[`${legacyPrefix}_${name}`]) || "";
  return {
    apiKey: read("API_KEY"),
    // Outbound webhooks (PMS → system). Empty URL = no webhooks for this system.
    webhookUrl: read("WEBHOOK_URL"),
    webhookSecret: read("WEBHOOK_SECRET"),
    // Optional override of the default event subscription (comma-separated event names).
    webhookEvents: list(read("WEBHOOK_EVENTS")),
    // Inbound request signing (system → PMS). When set, every request must carry a valid HMAC signature.
    inboundSecret: read("INBOUND_SECRET"),
  };
}

const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
  throw new Error("SESSION_SECRET must be set (>= 32 characters) in production.");
}

export const config = {
  rootDir,
  env,
  isProduction,
  isTest: env === "test",
  port: int(process.env.PORT, 3000),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  session: {
    secret: sessionSecret || "dev-only-insecure-session-secret-change-me",
    maxAgeMs: int(process.env.SESSION_MAX_AGE_MINUTES, 720) * 60 * 1000,
    secureCookie: bool(process.env.SESSION_SECURE_COOKIE, isProduction),
  },

  db: {
    host: process.env.DB_HOST || "localhost",
    port: int(process.env.DB_PORT, 3306),
    name: process.env.DB_NAME || "FrontDesk",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    logging: bool(process.env.DB_LOGGING, false),
  },

  hotel: {
    name: process.env.HOTEL_NAME || "Hotel FrontDesk",
    timezone: process.env.HOTEL_TIMEZONE || "Asia/Manila",
    // Offset used by MySQL DATETIME columns; keep in sync with HOTEL_TIMEZONE.
    utcOffset: process.env.HOTEL_UTC_OFFSET || "+08:00",
    currency: process.env.HOTEL_CURRENCY || "PHP",
  },

  paymentGateway: {
    driver: process.env.PAYMENT_GATEWAY_DRIVER || "sandbox",
    timeoutMs: int(process.env.PAYMENT_GATEWAY_TIMEOUT_MS, 15000),
  },

  integrations: {
    rateLimitPerMinute: int(process.env.INTEGRATION_RATE_LIMIT_PER_MINUTE, 120),
    outboxIntervalMs: int(process.env.INTEGRATION_OUTBOX_INTERVAL_MS, 15000),
    outboxMaxAttempts: int(process.env.INTEGRATION_OUTBOX_MAX_ATTEMPTS, 8),
    webhookTimeoutMs: int(process.env.INTEGRATION_WEBHOOK_TIMEOUT_MS, 10000),
    // Integration endpoints refuse plain HTTP (behind a TLS proxy set TRUST_PROXY=true).
    requireHttps: bool(process.env.INTEGRATION_REQUIRE_HTTPS, isProduction),
    // Max clock difference accepted on signed inbound requests (replay window).
    signatureToleranceSeconds: int(process.env.INTEGRATION_SIGNATURE_TOLERANCE_SECONDS, 300),
    // StayBook online booking (calls in with the BOOKING key, see integrations/staybook).
    staybook: {
      // StayBook's id for THIS hotel. When set, bookings for any other StayBook hotel are refused.
      hotelId: process.env.STAYBOOK_HOTEL_ID?.trim() || null,
    },
    // One entry per external system. An empty API key disables that system.
    clients: {
      BOOKING: integrationClient("BOOKING", "RESERVATION"),
      POS: integrationClient("POS"),
      HOUSEKEEPING: integrationClient("HOUSEKEEPING"),
      HR: integrationClient("HR"),
    },
  },
};

export default config;
