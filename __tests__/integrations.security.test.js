/**
 * Integration security: per-system API keys, scope-based authorization,
 * idempotency, HMAC request signatures with a replay window, HTTPS enforcement.
 * The member systems are simulated with IntegrationClient (no other app needs to run).
 */
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
