/**
 * Consistent JSON envelope for every API response:
 *   success: { success: true, data, meta? }
 *   failure: { success: false, error: { code, message, details? } }
 */
export const ok = (res, data, meta, status = 200) => {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
};

export const created = (res, data, meta) => ok(res, data, meta, 201);

export const fail = (res, status, code, message, details) => {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ success: false, error });
};

/** Wraps an async route handler so rejected promises reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parses ?page=&limit= with sane bounds. */
export const pagination = (query, { defaultLimit = 25, maxLimit = 100 } = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
};

export const pageMeta = ({ page, limit }, total) => ({ page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
