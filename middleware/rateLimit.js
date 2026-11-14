/**
 * In-memory fixed-window rate limiter (single application server, as in the
 * deployment diagram). Used for login attempts and integration endpoints.
 */
import { fail } from "../utils/http.js";

export const rateLimit = ({ windowMs = 60_000, max = 60, key = (req) => req.ip, code = "RATE_LIMITED", message } = {}) => {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      if (req.originalUrl.startsWith("/api/")) {
        return fail(res, 429, code, message || "Too many requests. Please slow down.");
      }
      return res.status(429).render("login", {
        title: "Sign in",
        error: message || "Too many attempts. Please wait a minute and try again.",
      });
    }
    next();
  };
};
