/**
 * Reusable UI helpers: safe HTML templating, formatting, badges, toasts,
 * modal forms with server-side validation errors, confirm dialogs, loading
 * and empty states. All dynamic values are HTML-escaped by `html`.
 */
import { ApiError } from "./api.js";

// ── Safe templating ─────────────────────────────────────────────────────────
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s ?? ""));
const render = (v) => {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === false || v === null || v === undefined) return "";
  return esc(v);
};
/** Tagged template: interpolations are escaped unless wrapped in raw() or nested html``. */
export const html = (strings, ...values) => raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ""), ""));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const setHTML = (el, content) => {
  el.innerHTML = String(content);
  applySizes(el);
};
/** CSP forbids inline style attributes; widths/heights are applied via CSSOM from data-w / data-h. */
export const applySizes = (root) => {
  $$("[data-w]", root).forEach((e) => (e.style.width = `${e.dataset.w}%`));
  $$("[data-h]", root).forEach((e) => (e.style.height = `${e.dataset.h}%`));
};

// ── Session context ─────────────────────────────────────────────────────────
export const session = {
  role: document.body.dataset.role,
  userId: Number(document.body.dataset.userId),
  entityId: Number(document.body.dataset.entityId) || null,
  currency: document.body.dataset.currency || "PHP",
  get isReceptionist() {
    return this.role === "RECEPTIONIST";
  },
  get isAdmin() {
    return this.role === "ADMINISTRATOR";
  },
};

// ── Formatting ──────────────────────────────────────────────────────────────
const moneyFmt = new Intl.NumberFormat("en-PH", { style: "currency", currency: session.currency, minimumFractionDigits: 2 });
export const money = (n) => moneyFmt.format(Number(n || 0));
export const date = (iso) =>
  iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "—";
export const dateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-PH", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
export const shortDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) : "");
export const label = (s) => String(s || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");

const BADGE = {
  CONFIRMED: "blue", CHECKED_IN: "green", CHECKED_OUT: "plain", CANCELLED: "red",
  OCCUPIED: "blue", IN_HOUSE: "green", DIRTY: "amber", CLEANING: "sky",
  DRAFT: "amber", PAID: "green",
  VERIFIED: "green", FAILED: "red", SUCCESSFUL: "green",
  PENDING: "amber", SENT: "green", SKIPPED: "plain",
  RECEPTIONIST: "sky", ADMINISTRATOR: "violet",
  FRONT_DESK: "plain", RESERVATION_SYSTEM: "violet", BOOKING: "violet", POS: "sky", HOUSEKEEPING: "amber", HR: "plain",
  AVAILABLE: "green", RESERVED: "blue", MAINTENANCE: "red", INACTIVE: "plain", DELETED: "plain",
  // Restaurant POS purchases
  PENDING_REVIEW: "amber", NEEDS_GUEST_VERIFICATION: "red", ADDED_TO_FOLIO: "green", REJECTED: "plain", ALREADY_PAID: "sky",
  // StayBook online reservations and notifications
  ONLINE_RESERVATION_NEW: "green", ONLINE_RESERVATION_UPDATED: "blue", ONLINE_RESERVATION_CANCELLED: "plain",
  ROOM_CONFLICT: "red", SYNC_FAILED: "red", ACKNOWLEDGED: "green", UPDATED: "blue",
  WEBHOOK_FAILED: "red", WEBHOOK_PENDING: "amber", LOCAL_CONFIRMED: "amber", ADMIN_CONFIRMED: "green", ONLINE_HOLD: "amber",
};
export const badge = (status, text) => {
  const tone = BADGE[status] || "plain";
  return html`<span class="badge ${tone === "plain" ? "" : `badge-${tone}`}">${text || label(status)}</span>`;
};

/** Room status as staff see it: the stored lifecycle status, or Inactive / Deleted for rooms out of inventory. */
const ROOM_STATUS_TEXT = {
  AVAILABLE: "Available", RESERVED: "Reserved", OCCUPIED: "Occupied", DIRTY: "Dirty", CLEANING: "Cleaning",
  MAINTENANCE: "Under maintenance", INACTIVE: "Inactive", DELETED: "Deleted",
};
export const isRoomReady = (room) => room.status === "AVAILABLE" || room.status === "RESERVED";
export const roomDisplayStatus = (room) =>
  room.displayStatus || (room.archivedAt ? "DELETED" : room.isActive === false ? "INACTIVE" : room.status);
export const roomStatusBadge = (room) => {
  const s = roomDisplayStatus(room);
  return badge(s, ROOM_STATUS_TEXT[s] || label(s));
};

// ── Feedback ────────────────────────────────────────────────────────────────
export function toast(message, type = "info", ms = 4200) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const errorMessage = (err) => (err instanceof ApiError ? err.message : "Unexpected error. Please try again.");
export const toastError = (err) => toast(errorMessage(err), "error", 6000);

export const loadingHTML = (text = "Loading…") => html`<div class="loading"><span class="spinner"></span>${text}</div>`;
export const emptyHTML = (title, text = "") => html`<div class="empty"><strong>${title}</strong>${text}</div>`;
export const errorHTML = (err) => html`<div class="alert alert-danger">${errorMessage(err)}</div>`;

/** Disables a button and shows a spinner while `fn` runs (prevents double submits). */
export async function withBusy(button, fn) {
  if (!button) return fn();
  if (button.disabled) return undefined;
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner"></span>${esc(button.textContent.trim())}`;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

// ── Forms ───────────────────────────────────────────────────────────────────
/** Collects named fields; empty strings are omitted unless keepEmpty; checkboxes → boolean. */
export function formValues(form, { keepEmpty = false } = {}) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
    } else if ("password" in el.dataset) {
      // Passwords are sent exactly as typed (spaces are significant).
      if (el.value !== "" || keepEmpty) out[el.name] = el.value;
    } else if (el.value.trim() !== "" || keepEmpty) out[el.name] = el.value.trim();
  }
  return out;
}

export function clearFieldErrors(form) {
  $$(".field-error[data-generated]", form).forEach((e) => e.remove());
  $$(".has-error", form).forEach((e) => e.classList.remove("has-error"));
}

/** Shows 422 field errors next to inputs (supports nested keys like guest.email). */
export function showFieldErrors(form, details, prefix = "") {
  if (!details || typeof details !== "object") return false;
  let shown = false;
  for (const [key, msg] of Object.entries(details)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (msg && typeof msg === "object") {
      shown = showFieldErrors(form, msg, name) || shown;
      continue;
    }
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`) || form.querySelector(`[name="${CSS.escape(key)}"]`);
    const field = input?.closest(".field");
    if (!field) continue;
    field.classList.add("has-error");
    const e = document.createElement("div");
    e.className = "field-error";
    e.dataset.generated = "1";
    e.textContent = msg;
    field.appendChild(e);
    shown = true;
  }
  return shown;
}

/** Turns { "guest.firstName": "x" } into { guest: { firstName: "x" } }. */
export function nest(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const parts = k.split(".");
    let cur = out;
    parts.slice(0, -1).forEach((p) => (cur = cur[p] ??= {}));
    cur[parts.at(-1)] = v;
  }
  return out;
}

// ── Password inputs ─────────────────────────────────────────────────────
let fieldSeq = 0;
/**
 * Password input with a show/hide toggle. Existing passwords are never
 * pre-filled; the toggle only reveals what the user is typing.
 */
export const passwordField = ({ name, label: text, autocomplete = "new-password", required = true, hint = "", extra = "" }) => {
  const id = `pw-${name}-${++fieldSeq}`;
  return html`<div class="field">
    <label for="${id}">${text}</label>
    <div class="input-group">
      <input id="${id}" name="${name}" type="password" data-password autocomplete="${autocomplete}" maxlength="200"
        spellcheck="false" autocapitalize="off" ${required ? raw("required") : ""}>
      <button type="button" class="input-addon" data-toggle-password aria-controls="${id}" aria-pressed="false" aria-label="Show password">Show</button>
    </div>
    ${hint ? html`<div class="hint">${hint}</div>` : ""}${raw(String(extra))}
  </div>`;
};

document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-toggle-password]");
  if (!button) return;
  const input = document.getElementById(button.getAttribute("aria-controls"));
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  button.textContent = show ? "Hide" : "Show";
  button.setAttribute("aria-pressed", String(show));
  button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  input.focus();
});

// ── Modals ──────────────────────────────────────────────────────────────────
/**
 * openModal({ title, body, submitLabel, onSubmit(values, form), wide, danger })
 * onSubmit may throw ApiError: field errors are shown inline, others in the modal.
 * Resolves with onSubmit's return value, or null if cancelled.
 */
export function openModal({ title, body, submitLabel = "Save", cancelLabel = "Cancel", onSubmit, wide = false, danger = false, onOpen }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = String(html`
      <form class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
        <div class="modal-head"><h2 id="modal-title">${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></div>
        <div class="modal-body"><div class="modal-alert"></div>${raw(String(body))}</div>
        <div class="modal-foot">
          <button type="button" class="btn ${danger ? "btn-secondary" : "btn-cancel"}" data-close>${cancelLabel}</button>
          ${onSubmit ? html`<button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${submitLabel}</button>` : ""}
        </div>
      </form>`);
    document.body.appendChild(backdrop);
    applySizes(backdrop);
    const form = backdrop.querySelector("form");
    const alertBox = backdrop.querySelector(".modal-alert");
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e) => e.key === "Escape" && close(null);
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop || e.target.closest("[data-close]")) close(null);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      clearFieldErrors(form);
      alertBox.innerHTML = "";
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      try {
        const result = await withBusy(button, () => onSubmit(formValues(form), form));
        close(result === undefined ? true : result);
      } catch (err) {
        const inline = err instanceof ApiError && err.status === 422 && showFieldErrors(form, err.details);
        if (!inline || err.message !== "Some fields are invalid.") {
          setHTML(alertBox, html`<div class="alert alert-danger">${errorMessage(err)}</div>`);
        }
      }
    });
    onOpen?.(form);
    (form.querySelector("input:not([type=hidden]), select, textarea") || form.querySelector("button[type=submit]"))?.focus();
  });
}

export const confirmDialog = (message, { title = "Please confirm", confirmLabel = "Confirm", danger = false } = {}) =>
  openModal({ title, body: html`<p>${message}</p>`, submitLabel: confirmLabel, danger, onSubmit: async () => true }).then(Boolean);

export const debounce = (fn, ms = 300) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/** Random key so a double-clicked / retried submit is recognisable. */
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export const queryParam = (name) => new URLSearchParams(window.location.search).get(name);
export const setQueryParam = (name, value) => {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  history.replaceState(null, "", url);
};

export const pagerHTML = (meta) =>
  meta && meta.pages > 1
    ? html`<div class="pager"><span>Page ${meta.page} of ${meta.pages} · ${meta.total} records</span>
        <span class="row"><button class="btn btn-sm" data-goto-page="${meta.page - 1}" ${meta.page <= 1 ? raw("disabled") : ""}>Previous</button>
        <button class="btn btn-sm" data-goto-page="${meta.page + 1}" ${meta.page >= meta.pages ? raw("disabled") : ""}>Next</button></span></div>`
    : meta
      ? html`<div class="pager"><span>${meta.total} record${meta.total === 1 ? "" : "s"}</span></div>`
      : "";
