/**
 * Thin client for the staff REST API (/api/v1). Sends the CSRF token, parses
 * the { success, data | error } envelope and throws ApiError on failure.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const csrf = () => document.body.dataset.csrf;

const buildUrl = (path, params) => {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  return url;
};

async function request(method, path, { body, params, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(buildUrl(path, params), {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-CSRF-Token": csrf() } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check the network connection and try again.");
  }

  if (response.status === 401) {
    window.location.href = "/login";
    throw new ApiError(401, "UNAUTHORIZED", "Your session has ended. Please sign in again.");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* non-JSON */
  }
  if (!response.ok || !payload || payload.success === false) {
    const err = payload?.error || {};
    throw new ApiError(response.status, err.code || "ERROR", err.message || `Request failed (${response.status}).`, err.details);
  }
  return { data: payload.data, meta: payload.meta };
}

export const api = {
  get: (path, params) => request("GET", path, { params }).then((r) => r.data),
  list: (path, params) => request("GET", path, { params }),
  post: (path, body = {}) => request("POST", path, { body }).then((r) => r.data),
  put: (path, body = {}) => request("PUT", path, { body }).then((r) => r.data),
  patch: (path, body = {}) => request("PATCH", path, { body }).then((r) => r.data),
  delete: (path) => request("DELETE", path).then((r) => r.data),
};
