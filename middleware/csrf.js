/**
 * Synchroniser-token CSRF protection for cookie-session requests.
 * - Every session gets a random token, exposed to views as `csrfToken`.
 * - Unsafe methods must send it as the `X-CSRF-Token` header (fetch) or a
 *   `_csrf` form field.
 * Integration endpoints authenticate with API keys (no cookies) and are
 * mounted before this middleware, so they are not affected.
 */
import crypto from "crypto";
import { fail } from "../utils/http.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

const equal = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const csrfProtection = (req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.locals.csrfToken = req.session.csrfToken;
  if (SAFE.has(req.method)) return next();

  const sent = req.get("x-csrf-token") || req.body?._csrf;
  if (sent && equal(sent, req.session.csrfToken)) return next();

  if (req.originalUrl.startsWith("/api/")) {
    return fail(res, 403, "CSRF_TOKEN_INVALID", "Security token missing or expired. Reload the page and try again.");
  }
  return res.status(403).render("error", {
    title: "Session expired",
    status: 403,
    message: "Your form session expired. Please go back, reload the page and try again.",
  });
};
