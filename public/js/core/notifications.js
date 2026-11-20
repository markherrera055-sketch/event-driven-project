/**
 * Restaurant-charge notifications for every staff page: the bell in the top
 * bar and the count next to "Restaurant charges" in the sidebar.
 *
 * The application has no push channel, so this polls GET /pos-orders/summary
 * (counts only, no guest data) every 30 seconds while the tab is visible, and
 * immediately when it becomes visible again. A toast announces a purchase
 * that arrived since the last check. Pages can listen for the
 * "pos-orders:summary" event to refresh themselves.
 */
import { api } from "./api.js";
import { toast } from "./ui.js";

const INTERVAL_MS = 30_000;
const SEEN_KEY = "fd.posOrders.lastSeenId";
const counters = [...document.querySelectorAll("[data-pos-count]")];
const bell = document.getElementById("notify-bell");

// Per-tab memory of the newest purchase already announced (best effort: storage may be unavailable).
const readSeen = () => {
  try {
    const v = Number(sessionStorage.getItem(SEEN_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeSeen = (id) => {
  try {
    sessionStorage.setItem(SEEN_KEY, String(id));
  } catch {
    /* ignore */
  }
};

let lastSeen = readSeen();
let timer = null;
let inFlight = false;

function render(s) {
  const n = s.attention;
  for (const el of counters) {
    el.textContent = n > 99 ? "99+" : String(n);
    el.classList.toggle("hidden", n === 0);
    el.classList.toggle("danger", s.needsAdjustment > 0);
  }
  if (bell) {
    const parts = [];
    if (s.pendingReview) parts.push(`${s.pendingReview} awaiting review`);
    if (s.needsVerification) parts.push(`${s.needsVerification} need guest verification`);
    if (s.needsAdjustment) parts.push(`${s.needsAdjustment} voided after billing`);
    const text = parts.length ? `Restaurant purchases: ${parts.join(", ")}` : "No restaurant purchases need attention";
    bell.title = text;
    bell.setAttribute("aria-label", text);
    bell.classList.toggle("has-items", n > 0);
  }
}

export async function refreshNotifications() {
  if (inFlight) return;
  inFlight = true;
  try {
    const s = await api.get("/pos-orders/summary");
    render(s);
    if (s.latestOpenId) {
      if (lastSeen !== null && s.latestOpenId > lastSeen) {
        toast(s.open === 1 ? "A new restaurant purchase is waiting for review." : `${s.open} restaurant purchases are waiting for review.`, "info", 6000);
      }
      if (lastSeen === null || s.latestOpenId > lastSeen) {
        lastSeen = s.latestOpenId;
        writeSeen(lastSeen);
      }
    }
    document.dispatchEvent(new CustomEvent("pos-orders:summary", { detail: s }));
  } catch {
    /* Network hiccup: keep the last counts; the next poll retries. */
  } finally {
    inFlight = false;
  }
}

function schedule() {
  clearInterval(timer);
  timer = document.visibilityState === "visible" ? setInterval(refreshNotifications, INTERVAL_MS) : null;
}

// Accounts that must still replace a temporary password cannot use the API yet.
if (counters.length && document.body.dataset.passwordChange !== "required") {
  refreshNotifications();
  schedule();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshNotifications();
    schedule();
  });
}
