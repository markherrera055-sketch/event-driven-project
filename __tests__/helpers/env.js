// Test environment — loaded before any application module (see jest.config.js).
process.env.NODE_ENV = "test";
process.env.ENV_FILE = "__no_env_file__"; // ignore the developer's .env
process.env.DB_NAME = process.env.TEST_DB_NAME || "FrontDesk_test";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
process.env.POS_API_KEY = "test-pos-key-0123456789";
process.env.RESERVATION_API_KEY = "test-reservation-key-0123456789";
process.env.RESERVATION_WEBHOOK_URL = "http://127.0.0.1:39123/webhooks/pms";
process.env.RESERVATION_WEBHOOK_SECRET = "test-webhook-secret";
process.env.POS_WEBHOOK_URL = "";
process.env.PAYMENT_GATEWAY_DRIVER = "sandbox";
