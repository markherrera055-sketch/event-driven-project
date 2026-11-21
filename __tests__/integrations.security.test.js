/**
 * Integration security: per-system API keys, scope-based authorization,
 * idempotency, HMAC request signatures with a replay window, HTTPS enforcement.
 * The member systems are simulated with IntegrationClient (no other app needs to run).
 */
import { jest } from "@jest/globals";
import { resetDatabase, startApp, StaffClient, IntegrationClient, PASSWORDS, newKey } from "./helpers/harness.js";
import { config } from "../config/index.js";
import { signPayload, verifySignature } from "../integrations/shared/signature.js";
import { IntegrationRequest } from "../models/index.js";
import { today, addDays } from "../utils/dates.js";

let app;
let booking;
let pos;
let housekeeping;
let hr;
const HK_SECRET = process.env.HOUSEKEEPING_INBOUND_SECRET;

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  booking = new IntegrationClient(app.base, "booking", process.env.BOOKING_API_KEY);
  pos = new IntegrationClient(app.base, "pos", process.env.POS_API_KEY);
  housekeeping = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY, { signingSecret: HK_SECRET });
  hr = new IntegrationClient(app.base, "hr", process.env.HR_API_KEY);
});
afterAll(() => app?.close());

const bookingBody = (id, extra = {}) => ({
  external_reservation_id: id,
  guest: { first_name: "Sec", last_name: "Tester", email: `${id.toLowerCase()}@example.com` },
  room_type: "Family",
  check_in_date: addDays(today(), 30),
  check_out_date: addDays(today(), 31),
  number_of_guests: 2,
  ...extra,
});

describe("Authentication (who is calling)", () => {
  test("missing API key → 401", async () => {
    const res = await pos.get("/in-house?room_number=101", { apiKey: "" });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("INVALID_API_KEY");
  });

  test("unknown API key → 401", async () => {
    expect((await booking.get("/room-types", { apiKey: "not-a-real-key-123" })).status).toBe(401);
  });

  test("Authorization: Bearer is accepted as well as X-Api-Key", async () => {
    const res = await fetch(`${app.base}/api/v1/integrations/booking/room-types`, { headers: { Authorization: `Bearer ${process.env.BOOKING_API_KEY}` } });
    expect(res.status).toBe(200);
  });

  test("a staff session cookie is not accepted in place of an API key", async () => {
    const desk = await new StaffClient(app.base).login("frontdesk", PASSWORDS.frontdesk);
    const res = await desk.raw("GET", "/api/v1/integrations/pos/in-house?room_number=101");
    expect(res.status).toBe(401);
  });
});

describe("Authorization (what each system may do)", () => {
  test.each([
    ["POS key on booking endpoints", "booking", "/room-types", process.env.POS_API_KEY],
    ["Booking key on POS endpoints", "pos", "/in-house?room_number=101", process.env.BOOKING_API_KEY],
    ["HR key on housekeeping endpoints", "housekeeping", "/rooms", process.env.HR_API_KEY],
    ["Housekeeping key on HR endpoints", "hr", "/housekeeping-tasks?from=2026-01-01&to=2026-01-02", process.env.HOUSEKEEPING_API_KEY],
  ])("%s → 403 INSUFFICIENT_SCOPE", async (_, system, path, key) => {
    const client = new IntegrationClient(app.base, system, key);
    const res = await client.get(path);
    expect(res.status).toBe(403);
    expect(res.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  test("HR cannot post housekeeping completions (read-only integration)", async () => {
    const asHr = new IntegrationClient(app.base, "housekeeping", process.env.HR_API_KEY);
    const res = await asHr.post("/cleaning-completed", { external_task_id: "HK-X", room_number: "101", status: "COMPLETED", completed_by: "EMP-1", completed_at: new Date().toISOString() });
    expect(res.status).toBe(403);
  });

  test("the PMS does not relay housekeeping logs to HR (no such endpoint)", async () => {
    const res = await hr.post("/housekeeping-logs", { external_log_id: "HKLOG-1" });
    expect(res.status).toBe(404);
  });
});

describe("Idempotency and request validation", () => {
  test("a write without Idempotency-Key → 400", async () => {
    const res = await booking.post("/reservations", bookingBody("SEC-1"), { idempotencyKey: null });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  test("a retry with the same key and body replays the stored response", async () => {
    const key = newKey("sec");
    const first = await booking.post("/reservations", bookingBody("SEC-2"), { key });
    expect(first.status).toBe(201);
    const retry = await booking.post("/reservations", bookingBody("SEC-2"), { key });
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.data.reservation_id).toBe(first.data.reservation_id);
  });

  test("the same key with a different body → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const key = newKey("sec");
    await booking.post("/reservations", bookingBody("SEC-3"), { key });
    const res = await booking.post("/reservations", bookingBody("SEC-3", { number_of_guests: 1 }), { key });
    expect(res.status).toBe(422);
    expect(res.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("malformed JSON → 400 INVALID_JSON", async () => {
    const res = await fetch(`${app.base}/api/v1/integrations/booking/reservations`, {
      method: "POST",
      headers: { "X-Api-Key": process.env.BOOKING_API_KEY, "Idempotency-Key": newKey(), "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_JSON");
  });

  test("accepted writes are recorded in the audit log", async () => {
    const rows = await IntegrationRequest.findAll({ where: { source: "BOOKING" } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.path.startsWith("/api/v1/integrations/booking"))).toBe(true);
  });
});

describe("Signed requests (Housekeeping has an inbound secret)", () => {
  const body = () => ({ external_task_id: `HK-SIG-${Date.now()}`, room_number: "101", status: "COMPLETED", completed_by: "EMP-001", completed_at: new Date().toISOString() });

  test("unsigned write → 401 SIGNATURE_REQUIRED", async () => {
    const res = await housekeeping.post("/cleaning-completed", body(), { sign: false });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("SIGNATURE_REQUIRED");
  });

  test("signature made with the wrong secret → 401 INVALID_SIGNATURE", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const b = body();
    const res = await housekeeping.post("/cleaning-completed", b, { timestamp: ts, signature: signPayload("wrong-secret", ts, JSON.stringify(b)) });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("INVALID_SIGNATURE");
  });

  test("body changed after signing → 401 INVALID_SIGNATURE", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const signedFor = body();
    const res = await housekeeping.post("/cleaning-completed", { ...signedFor, room_number: "102" }, { timestamp: ts, signature: signPayload(HK_SECRET, ts, JSON.stringify(signedFor)) });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("INVALID_SIGNATURE");
  });

  test("a correctly signed but old request (replay) → 401 SIGNATURE_EXPIRED", async () => {
    const old = (Math.floor(Date.now() / 1000) - config.integrations.signatureToleranceSeconds - 60).toString();
    const res = await housekeeping.post("/cleaning-completed", body(), { timestamp: old });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("SIGNATURE_EXPIRED");
  });

  test("a valid signature passes authentication (then business rules apply)", async () => {
    const res = await housekeeping.post("/cleaning-completed", body());
    expect(res.status).toBe(409); // room 101 is AVAILABLE, not waiting for cleaning
    expect(res.error.code).toBe("ROOM_NOT_AWAITING_CLEANING");
  });

  test("reads do not need a signature", async () => {
    expect((await housekeeping.get("/rooms")).status).toBe(200);
  });

  test("verifySignature unit checks", () => {
    const now = 1_800_000_000_000;
    const ts = String(now / 1000);
    const sig = signPayload("s", ts, "{}");
    expect(verifySignature({ secret: "s", timestamp: ts, signature: sig, rawBody: "{}", toleranceSeconds: 300, now })).toBeNull();
    expect(verifySignature({ secret: "s", timestamp: ts, signature: sig, rawBody: "{ }", toleranceSeconds: 300, now })).toBe("INVALID_SIGNATURE");
    expect(verifySignature({ secret: "s", timestamp: "abc", signature: sig, rawBody: "{}", toleranceSeconds: 300, now })).toBe("INVALID_SIGNATURE");
    expect(verifySignature({ secret: "s", timestamp: ts, signature: sig, rawBody: "{}", toleranceSeconds: 300, now: now + 301_000 })).toBe("SIGNATURE_EXPIRED");
  });
});

describe("Transport", () => {
  test("plain HTTP is refused when HTTPS is required (production default)", async () => {
    config.integrations.requireHttps = true;
    try {
      const res = await booking.get("/room-types");
      expect(res.status).toBe(403);
      expect(res.error.code).toBe("HTTPS_REQUIRED");
    } finally {
      config.integrations.requireHttps = false;
    }
  });
});

describe("Housekeeping signing is mandatory outside the test environment", () => {
  const settings = () => config.integrations.clients.HOUSEKEEPING;

  /** Simulates a non-test deployment whose .env lacks HOUSEKEEPING_INBOUND_SECRET. */
  async function withoutSecret(enforce, fn) {
    const saved = { secret: settings().inboundSecret, enforce: config.integrations.enforceRequiredSigning };
    settings().inboundSecret = "";
    config.integrations.enforceRequiredSigning = enforce;
    try {
      await fn();
    } finally {
      settings().inboundSecret = saved.secret;
      config.integrations.enforceRequiredSigning = saved.enforce;
    }
  }

  test("enforcement is on in every NODE_ENV except test", async () => {
    const { execFileSync } = await import("child_process");
    const { pathToFileURL } = await import("url");
    const configUrl = pathToFileURL(`${config.rootDir}/config/index.js`).href;
    const enforcedUnder = (nodeEnv) => {
      const env = { ...process.env, ENV_FILE: "__no_env_file__", SESSION_SECRET: "x".repeat(40) };
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      const script = `const { config } = await import(${JSON.stringify(configUrl)}); process.stdout.write(String(config.integrations.enforceRequiredSigning));`;
      return execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }).trim();
    };
    expect(enforcedUnder(undefined)).toBe("true");
    expect(enforcedUnder("development")).toBe("true");
    expect(enforcedUnder("production")).toBe("true");
    expect(enforcedUnder("staging")).toBe("true");
    expect(enforcedUnder("test")).toBe("false");
  });

  test("without HOUSEKEEPING_INBOUND_SECRET every Housekeeping write is refused (503), signed or not, and nothing is stored", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    let calls = [];
    await withoutSecret(true, async () => {
      const unsigned = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY);
      const before = await IntegrationRequest.count();
      const calls = [
        [unsigned, "/cleaning-status", { status: "PENDING", external_task_id: "HK-NOSECRET-1", room_number: "101" }],
        [unsigned, "/cleaning-completed", { external_task_id: "HK-NOSECRET-2", room_number: "101", status: "COMPLETED", completed_by: "EMP-1", completed_at: new Date().toISOString() }],
        [housekeeping, "/cleaning-started", { external_task_id: "HK-NOSECRET-3", room_number: "101", started_by: "EMP-1" }], // signed with the old secret
      ];
      for (const [client, path, body] of calls) {
        const res = await client.post(path, body);
        expect(res.status).toBe(503);
        expect(res.error.code).toBe("INBOUND_SIGNING_NOT_CONFIGURED");
        expect(res.error.message).not.toMatch(/HOUSEKEEPING_INBOUND_SECRET/); // no config names leaked to callers
      }
      expect(await IntegrationRequest.count()).toBe(before); // refused before the idempotency store
      expect((await unsigned.get("/rooms")).status).toBe(200); // reads are unaffected

      const admin = await new StaffClient(app.base).login("admin", PASSWORDS.admin);
      const hk = (await admin.get("/admin/integrations")).data.status.clients.find((c) => c.source === "HOUSEKEEPING");
      expect(hk).toMatchObject({ inboundSigned: false, inboundSigningRequired: true, inboundSecretMissing: true });
    }).finally(() => {
      calls = logged.mock.calls.map(([line]) => String(line));
      logged.mockRestore();
    });
    // Each refusal is logged server-side as an error, naming the missing variable.
    expect(calls.filter((line) => /integration_signing_secret_missing.*HOUSEKEEPING_INBOUND_SECRET/.test(line))).toHaveLength(3);
  });

  test("systems that are not required to sign are unaffected by a missing secret", async () => {
    await withoutSecret(true, async () => {
      // An unsigned Booking write passes the signing stage and reaches validation (422, not 503 / 401).
      const res = await booking.post("/reservations", {});
      expect(res.status).toBe(422);
      expect(res.error.code).toBe("VALIDATION_ERROR");
    });
  });

  test("under NODE_ENV=test (enforcement off) a missing secret keeps the previous behaviour", async () => {
    await withoutSecret(false, async () => {
      const unsigned = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY);
      const res = await unsigned.post("/cleaning-tasks", { external_task_id: "HK-TESTENV-1", room_number: "101" });
      expect(res.status).toBe(409); // passed authentication; room 101 is not waiting for cleaning
      expect(res.error.code).toBe("ROOM_NOT_AWAITING_CLEANING");
    });
  });

  test("with the secret configured, unsigned writes are still refused (401)", async () => {
    const unsigned = new IntegrationClient(app.base, "housekeeping", process.env.HOUSEKEEPING_API_KEY);
    const res = await unsigned.post("/cleaning-status", { status: "PENDING", external_task_id: "HK-UNSIGNED-1", room_number: "101" });
    expect(res.status).toBe(401);
    expect(res.error.code).toBe("SIGNATURE_REQUIRED");
  });
});
