/**
 * Application error carrying an HTTP status, a stable machine-readable code,
 * a human-readable message and optional details (e.g. field errors).
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
export const validationError = (details, message = "Some fields are invalid.") =>
  new AppError(422, "VALIDATION_ERROR", message, details);
export const unauthorized = (message = "Authentication required.") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to perform this action.") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
