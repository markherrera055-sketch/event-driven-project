/**
 * Test harness: fresh test database, the real Express app on a random port,
 * and small HTTP clients for staff (cookie session + CSRF) and integrations
 * (API key + Idempotency-Key). No mocks: every request hits MySQL.
 */
import http from "http";
import { Sequelize } from "sequelize";
import { signPayload } from "../../integrations/shared/signature.js";
import { config } from "../../config/index.js";
import { sequelize, syncSchema, Room, User, ROLES } from "../../models/index.js";
import { hashPassword } from "../../services/authService.js";
import { startIntegrations } from "../../integrations/index.js";
import { stopOutboxWorker } from "../../integrations/shared/outbox.js";

export const PASSWORDS = { admin: "Admin#Pass2026", frontdesk: "Desk#Pass2026" };

export async function resetDatabase() {
  const root = new Sequelize("", config.db.user, config.db.password, { host: config.db.host, port: config.db.port, dialect: "mysql", logging: false });
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.name}\``);
  await root.close();
  await syncSchema({ fresh: true });
  await Room.bulkCreate([
    { roomNumber: "101", roomType: "Standard", capacity: 2, nightlyRate: 2500 },
    { roomNumber: "102", roomType: "Standard", capacity: 2, nightlyRate: 2500 },
    { roomNumber: "204", roomType: "Deluxe", capacity: 2, nightlyRate: 3500 },
    { roomNumber: "301", roomType: "Family", capacity: 4, nightlyRate: 5200 },
  ]);
  await User.bulkCreate([
    { fullName: "Ada Admin", username: "admin", role: ROLES.ADMINISTRATOR, passwordHash: await hashPassword(PASSWORDS.admin) },
    { fullName: "Liza Ramos", username: "frontdesk", role: ROLES.RECEPTIONIST, passwordHash: await hashPassword(PASSWORDS.frontdesk) },
  ]);
}

export async function startApp() {
  const { default: app } = await import("../../index.js");
  startIntegrations({ worker: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      stopOutboxWorker();
      await new Promise((r) => server.close(r));
      await sequelize.close();
    },
  };
}

/** Staff browser-like client: keeps the session cookie and CSRF token. */
export class StaffClient {
  constructor(base) {
    this.base = base;
    this.cookie = "";
    this.csrf = "";
  }

  async raw(method, path, { body, form, headers = {}, redirect = "manual" } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload;
    if (form) {
      h["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return res;
  }

  async refreshCsrf(path = "/dashboard") {
    const res = await this.raw("GET", path);
    const text = await res.text();
    const m = text.match(/data-csrf="([a-f0-9]+)"/) || text.match(/name="_csrf" value="([a-f0-9]+)"/);
    this.csrf = m ? m[1] : "";
    return res;
  }

  async login(username, password) {
    await this.refreshCsrf("/login");
    const res = await this.raw("POST", "/login", { form: { _csrf: this.csrf, username, password } });
    if (res.status !== 302) throw new Error(`login failed for ${username}: ${res.status}`);
    await this.refreshCsrf("/dashboard");
    return this;
  }

  async api(method, path, body, { csrf = true } = {}) {
    const headers = { Accept: "application/json" };
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = this.csrf;
    const res = await this.raw(method, `/api/v1${path}`, { body, headers });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json?.data, error: json?.error, headers: res.headers };
  }
  get(path) {
    return this.api("GET", path);
  }
  post(path, body = {}) {
    return this.api("POST", path, body);
  }
  put(path, body = {}) {
    return this.api("PUT", path, body);
  }
  patch(path, body = {}) {
    return this.api("PATCH", path, body);
  }
}

let keySeq = 0;
export const newKey = (prefix = "test") => `${prefix}-${Date.now()}-${++keySeq}`;

/**
 * External-system client (a simulated member system): API key + Idempotency-Key,
 * and HMAC request signing when constructed with a signing secret.
 */
export class IntegrationClient {
  constructor(base, system, apiKey, { signingSecret } = {}) {
    this.base = `${base}/api/v1/integrations/${system}`;
    this.apiKey = apiKey;
    this.signingSecret = signingSecret;
  }
  async call(method, path, body, { key, apiKey = this.apiKey, idempotencyKey, sign = true, timestamp, signature } = {}) {
    const headers = { Accept: "application/json" };
    if (apiKey) headers["X-Api-Key"] = apiKey;
    const raw = body !== undefined ? JSON.stringify(body) : undefined;
    if (raw !== undefined) headers["Content-Type"] = "application/json";
    const ik = idempotencyKey === undefined ? (method === "GET" ? undefined : key || newKey()) : idempotencyKey;
    if (ik) headers["Idempotency-Key"] = ik;
    if (this.signingSecret && sign && method !== "GET") {
      const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
      headers["X-Timestamp"] = ts;
      headers["X-Signature"] = signature ?? signPayload(this.signingSecret, ts, raw ?? "");
    }
    const res = await fetch(this.base + path, { method, headers, body: raw });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json?.data, error: json?.error, headers: res.headers, key: ik };
  }
  get(path, opts) {
    return this.call("GET", path, undefined, opts);
  }
  post(path, body = {}, opts) {
    return this.call("POST", path, body, opts);
  }
  patch(path, body = {}, opts) {
    return this.call("PATCH", path, body, opts);
  }
}

export const RECEIVER_PORTS = { BOOKING: 39123, POS: 39124, HOUSEKEEPING: 39125 };

/**
 * Local HTTP server standing in for a member system's webhook endpoint.
 * receiver.respondWith(status) sets the HTTP status it answers with (to
 * simulate an outage); every request is recorded with its raw body.
 */
export async function startReceiver(system, secret) {
  const received = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const ts = req.headers["x-pms-timestamp"];
      received.push({
        headers: req.headers,
        raw,
        body: JSON.parse(raw || "null"),
        signatureValid: !!secret && req.headers["x-pms-signature"] === signPayload(secret, ts, raw),
        answeredWith: status,
      });
      res.writeHead(status).end(status < 300 ? "ok" : "unavailable");
    });
  });
  await new Promise((r) => server.listen(RECEIVER_PORTS[system], "127.0.0.1", r));
  return {
    received,
    respondWith(code) {
      status = code;
    },
    events: (name) => received.filter((r) => r.answeredWith < 300 && (!name || r.body.event === name)).map((r) => r.body),
    clear() {
      received.length = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
