/**
 * Staff notifications on every page: the bell in the top bar (with a
 * dropdown), the count next to "Online reservations" and "Restaurant charges"
 * in the sidebar, and a toast when something new arrives.
 *
 * The application has no push channel, so this POLLS every 30 seconds while
 * the tab is visible, and immediately when it becomes visible again:
 *   GET /notifications/summary   StayBook online reservations + sync problems (per-user unread)
 *   GET /pos-orders/summary      restaurant purchases awaiting review (counts only)
 * A new notification can therefore take up to ~30 seconds to appear.
 *
 * Pages can listen for "notifications:summary" and "pos-orders:summary".
 */
import { api } from "./api.js";
import { html, setHTML, dateTime, toast, toastError } from "./ui.js";

const INTERVAL_MS = 30_000;
const POS_SEEN_KEY = "fd.posOrders.lastSeenId";
const NOTE_SEEN_KEY = "fd.notifications.lastSeenId";
const posCounters = [...document.querySelectorAll("[data-pos-count]")];
const onlineCounters = [...document.querySelectorAll("[data-online-count]")];
const bellCount = document.querySelector("[data-notify-count]");
const bell = document.getElementById("notify-bell");
const panel = document.getElementById("notify-panel");

// Per-tab memory of what was already announced (best effort: storage may be unavailable).
const readSeen = (key) => {
  try {
    const v = Number(sessionStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeSeen = (key, id) => {
  try {
    sessionStorage.setItem(key, String(id));
  } catch {
    /* ignore */
  }
};

let posSeen = readSeen(POS_SEEN_KEY);
let noteSeen = readSeen(NOTE_SEEN_KEY);
let pos = null;
let notes = null;
let timer = null;
let inFlight = false;

/** Where a notification leads: the online reservation it is about, or the list of sync issues. */
export const notificationHref = (n) =>
  n.reservationId ? `/front-desk/online-reservations?open=${n.reservationId}` : "/front-desk/online-reservations?view=issues";

const setCount = (el, n, danger) => {
  el.textContent = n > 99 ? "99+" : String(n);
  el.classList.toggle("hidden", n === 0);
  el.classList.toggle("danger", !!danger);
};

function render() {
  if (pos) for (const el of posCounters) setCount(el, pos.attention, pos.needsAdjustment > 0);
  if (notes) for (const el of onlineCounters) setCount(el, notes.unread, notes.problems > 0);
  if (!bell) return;
  const unread = notes?.unread || 0;
  const posAttention = pos?.attention || 0;
  if (bellCount) setCount(bellCount, unread + posAttention, (notes?.problems || 0) > 0 || (pos?.needsAdjustment || 0) > 0);
  const parts = [];
  if (unread) parts.push(`${unread} unread notification${unread === 1 ? "" : "s"}${notes.problems ? ` (${notes.problems} need attention)` : ""}`);
  if (posAttention) parts.push(`${posAttention} restaurant purchase${posAttention === 1 ? "" : "s"} need attention`);
  const text = parts.length ? `Notifications: ${parts.join(", ")}` : "Notifications: nothing new";
  bell.title = text;
  bell.setAttribute("aria-label", text);
  bell.classList.toggle("has-items", unread + posAttention > 0);
}

function announce() {
  if (pos?.latestOpenId) {
    if (posSeen !== null && pos.latestOpenId > posSeen) {
      toast(pos.open === 1 ? "A new restaurant purchase is waiting for review." : `${pos.open} restaurant purchases are waiting for review.`, "info", 6000);
    }
    if (posSeen === null || pos.latestOpenId > posSeen) writeSeen(POS_SEEN_KEY, (posSeen = pos.latestOpenId));
  }
  const latest = notes?.latestUnread;
  if (latest) {
    // Only announce what arrived after this tab started watching (no toast storm on first load).
    if (noteSeen !== null && latest.id > noteSeen) toast(`${latest.title}. ${latest.message}`, latest.problem ? "warning" : "info", 9000);
    if (noteSeen === null || latest.id > noteSeen) writeSeen(NOTE_SEEN_KEY, (noteSeen = latest.id));
  }
}

export async function refreshNotifications() {
  if (inFlight) return;
  inFlight = true;
  try {
    const [p, n] = await Promise.allSettled([api.get("/pos-orders/summary"), api.get("/notifications/summary")]);
    // A network hiccup keeps the last counts; the next poll retries.
    if (p.status === "fulfilled") pos = p.value;
    if (n.status === "fulfilled") notes = n.value;
    render();
    announce();
    if (p.status === "fulfilled") document.dispatchEvent(new CustomEvent("pos-orders:summary", { detail: pos }));
    if (n.status === "fulfilled") document.dispatchEvent(new CustomEvent("notifications:summary", { detail: notes }));
    if (panel && !panel.classList.contains("hidden") && n.status === "fulfilled") loadPanel();
  } finally {
    inFlight = false;
  }
}

// ── Dropdown ────────────────────────────────────────────────────────────────

let shown = [];

const itemHTML = (n) => html`<li class="np-item ${n.read ? "" : "unread"} ${n.problem ? "problem" : ""}">
  <a href="${notificationHref(n)}" data-np-open="${n.id}">
    <span class="np-dot" aria-hidden="true"></span>
    <span class="np-text"><strong>${n.title}</strong><span class="np-msg">${n.message}</span><span class="np-time">${dateTime(n.createdAt)}${n.read ? "" : html` · <span class="sr-only">unread</span>New`}</span></span>
  </a></li>`;

async function loadPanel() {
  try {
    const { data } = await api.list("/notifications", { limit: 8 });
    shown = data;
    const posAttention = pos?.attention || 0;
    setHTML(
      panel,
      html`<div class="np-head"><strong>Notifications</strong>
          ${notes?.unread ? html`<button type="button" class="btn btn-sm btn-ghost" data-np-readall>Mark all read</button>` : ""}</div>
        ${data.length ? html`<ul class="np-list">${data.map(itemHTML)}</ul>` : html`<p class="np-empty">No online reservation notifications yet.</p>`}
        ${posAttention ? html`<a class="np-row" href="/front-desk/restaurant-charges">${posAttention} restaurant purchase${posAttention === 1 ? "" : "s"} need attention →</a>` : ""}
        <a class="np-row np-foot" href="/front-desk/online-reservations">All online reservations →</a>`
    );
  } catch (err) {
    setHTML(panel, html`<p class="np-empty">${err.message}</p>`);
  }
}

function openPanel() {
  panel.classList.remove("hidden");
  bell.setAttribute("aria-expanded", "true");
  setHTML(panel, html`<p class="np-empty">Loading…</p>`);
  loadPanel();
}
function closePanel() {
  panel.classList.add("hidden");
  bell.setAttribute("aria-expanded", "false");
}

if (bell && panel) {
  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel.classList.contains("hidden")) openPanel();
    else closePanel();
  });
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("hidden") && !panel.contains(e.target) && !bell.contains(e.target)) closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.classList.contains("hidden")) {
      closePanel();
      bell.focus();
    }
  });
  panel.addEventListener("click", async (e) => {
    const readAll = e.target.closest("[data-np-readall]");
    if (readAll) {
      try {
        const upToId = Math.max(0, ...shown.map((n) => n.id), notes?.latestUnread?.id || 0);
        await api.post("/notifications/read-all", upToId ? { upToId } : {});
        await refreshNotifications();
        loadPanel();
      } catch (err) {
        toastError(err);
      }
      return;
    }
    const link = e.target.closest("[data-np-open]");
    if (link) {
      e.preventDefault();
      // Opening a notification marks it read, then goes to the reservation it is about.
      await api.post(`/notifications/${link.dataset.npOpen}/read`).catch(() => {});
      window.location.href = link.getAttribute("href");
    }
  });
}

function schedule() {
  clearInterval(timer);
  timer = document.visibilityState === "visible" ? setInterval(refreshNotifications, INTERVAL_MS) : null;
}

// Accounts that must still replace a temporary password cannot use the API yet.
if ((bell || posCounters.length || onlineCounters.length) && document.body.dataset.passwordChange !== "required") {
  refreshNotifications();
  schedule();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshNotifications();
    schedule();
  });
}
