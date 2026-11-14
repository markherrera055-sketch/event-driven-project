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
    pos: {
      apiKey: process.env.POS_API_KEY || "",
      webhookUrl: process.env.POS_WEBHOOK_URL || "",
      webhookSecret: process.env.POS_WEBHOOK_SECRET || "",
    },
    reservations: {
      apiKey: process.env.RESERVATION_API_KEY || "",
      webhookUrl: process.env.RESERVATION_WEBHOOK_URL || "",
      webhookSecret: process.env.RESERVATION_WEBHOOK_SECRET || "",
    },
  },
};

export default config;
