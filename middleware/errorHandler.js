/**
 * Central error handling. Known errors are mapped to clear status codes;
 * unexpected errors are logged with a reference id and never leak internals.
 */
import crypto from "crypto";
import { UniqueConstraintError, ValidationError, ForeignKeyConstraintError } from "sequelize";
import { AppError } from "../utils/errors.js";
import { fail } from "../utils/http.js";
import { logger } from "../utils/logger.js";

const isApi = (req) => req.originalUrl.startsWith("/api/");

export const notFoundHandler = (req, res) => {
  if (isApi(req)) return fail(res, 404, "NOT_FOUND", `No endpoint ${req.method} ${req.path}`);
  res.status(404).render("error", { title: "Page not found", status: 404, message: "The page you requested does not exist." });
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "Something went wrong. Please try again.";
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof UniqueConstraintError) {
    status = 409;
    code = "DUPLICATE";
    message = "A record with the same unique value already exists.";
    details = Object.fromEntries((err.errors || []).map((e) => [e.path, "Already in use."]));
  } else if (err instanceof ForeignKeyConstraintError) {
    status = 409;
    code = "IN_USE";
    message = "This record is referenced by other records and cannot be changed this way.";
  } else if (err instanceof ValidationError) {
    status = 422;
    code = "VALIDATION_ERROR";
    message = "Some fields are invalid.";
    details = Object.fromEntries((err.errors || []).map((e) => [e.path, e.message]));
  } else if (err.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body is not valid JSON.";
  } else if (err.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request body is too large.";
  }

  if (status >= 500) {
    const ref = crypto.randomUUID();
    logger.error("unhandled_error", { ref, method: req.method, path: req.originalUrl, error: err.message, stack: err.stack });
    details = { reference: ref };
  }

  if (res.headersSent) return;
  if (isApi(req)) return fail(res, status, code, message, details);
  res.status(status).render("error", { title: "Error", status, message });
};
