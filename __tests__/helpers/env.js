// Test environment — loaded before any application module (see jest.config.js).
process.env.NODE_ENV = "test";
process.env.ENV_FILE = "__no_env_file__"; // ignore the developer's .env
process.env.DB_NAME = process.env.TEST_DB_NAME || "FrontDesk_test";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
process.env.PAYMENT_GATEWAY_DRIVER = "sandbox";

// One API key per external system (simulated members).
process.env.BOOKING_API_KEY = "test-booking-key-0123456789";
process.env.POS_API_KEY = "test-pos-key-0123456789";
process.env.HOUSEKEEPING_API_KEY = "test-housekeeping-key-0123456789";
process.env.HR_API_KEY = "test-hr-key-0123456789";
// Housekeeping must sign its requests.
process.env.HOUSEKEEPING_INBOUND_SECRET = "test-housekeeping-inbound-secret";

// Webhook receivers: local HTTP servers started by the tests (ports in harness.RECEIVER_PORTS).
process.env.BOOKING_WEBHOOK_URL = "http://127.0.0.1:39123/webhooks/pms";
process.env.BOOKING_WEBHOOK_SECRET = "test-booking-webhook-secret";
process.env.POS_WEBHOOK_URL = "http://127.0.0.1:39124/webhooks/pms";
process.env.POS_WEBHOOK_SECRET = "test-pos-webhook-secret";
process.env.HOUSEKEEPING_WEBHOOK_URL = "http://127.0.0.1:39125/webhooks/pms";
process.env.HOUSEKEEPING_WEBHOOK_SECRET = "test-housekeeping-webhook-secret";

process.env.INTEGRATION_OUTBOX_MAX_ATTEMPTS = "3";
process.env.INTEGRATION_WEBHOOK_TIMEOUT_MS = "2000";
// Integration rate limit high enough for the suites (tested separately via config).
process.env.INTEGRATION_RATE_LIMIT_PER_MINUTE = "1000";
