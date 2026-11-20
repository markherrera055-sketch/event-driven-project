/**
 * Online Reservations — bookings received from StayBook (one row per
 * StayBook booking; each is an ordinary Frontdesk reservation underneath).
 * Search and filters, a details panel with the booking history, and the
 * "Sync issues" tab (room conflicts and refused / failed synchronisation).
 *
 * New bookings show up through the 30-second notification poll
 * (core/notifications.js): when the unread count changes the list reloads.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, date, dateTime, badge, money, errorHTML, emptyHTML, loadingHTML, pagerHTML, debounce, queryParam, setQueryParam, openModal, toastError } from "../core/ui.js";
import { refreshNotifications } from "../core/notifications.js";
import { categoryBadge, syncBadge, STATUS_TEXT, EVENT_TEXT } from "../core/online.js";

const root = $("#page-root");
const VIEWS = [
  ["", "All"],
  ["upcoming", "Upcoming arrivals"],
  ["arrivals", "Arriving today"],
  ["cancelled", "Cancelled"],
  ["issues", "Sync issues"],
];
const FILTERS = ["guest", "reference", "room", "checkIn", "checkOut", "status"];
const state = { view: queryParam("view") || "", page: 1, filters: Object.fromEntries(FILTERS.map((f) => [f, queryParam(f) || ""])) };
let lastUnread = null;

setHTML(
  root,
  html`<div class="card">
    <div class="tabs" role="tablist">${VIEWS.map(([v, l]) => html`<button class="tab" data-view="${v}" role="tab">${l}${v === "issues" ? html`<span class="count hidden" id="issues-count"></span>` : ""}</button>`)}</div>
    <form class="toolbar filters" id="filters" role="search" autocomplete="off">
      <div class="field"><label for="f-guest">Guest name</label><input type="search" id="f-guest" name="guest" maxlength="100" value="${state.filters.guest}"></div>
      <div class="field"><label for="f-reference">Booking reference</label><input type="search" id="f-reference" name="reference" maxlength="100" placeholder="SB-… or RSV-…" value="${state.filters.reference}"></div>
      <div class="field"><label for="f-room">Room</label><input type="search" id="f-room" name="room" maxlength="10" value="${state.filters.room}"></div>
      <div class="field"><label for="f-checkin">Check-in</label><input type="date" id="f-checkin" name="checkIn" value="${state.filters.checkIn}"></div>
      <div class="field"><label for="f-checkout">Check-out</label><input type="date" id="f-checkout" name="checkOut" value="${state.filters.checkOut}"></div>
      <div class="field"><label for="f-status">Status</label><select id="f-status" name="status"><option value="">Any status</option>
        ${Object.entries(STATUS_TEXT).map(([v, l]) => html`<option value="${v}" ${state.filters.status === v ? html`selected` : ""}>${l}</option>`)}</select></div>
      <button type="button" class="btn btn-sm btn-ghost" id="clear-filters">Clear</button>
    </form>
    <div id="results"></div>
  </div>`
);
const results = $("#results");

const roomCell = (r) =>
  r.room
    ? html`<strong>${r.room.roomNumber}</strong><div class="sub">${r.room.roomType}${r.roomChangedByFrontDesk ? html` · booked ${r.bookedRoomNumber}` : ""}</div>`
    : html`<span class="badge badge-amber plain">Unassigned</span><div class="sub">${r.roomType}</div>`;

function reservationsTable(data, meta) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>StayBook ref.</th><th>Guest</th><th>Room</th><th>Check-in</th><th>Check-out</th><th>Guests</th><th>Status</th><th>Received</th><th>Sync</th></tr></thead>
    <tbody>${data.map(
      (r) => html`<tr class="clickable ${r.unreadNotifications ? "row-new" : ""}" data-open="${r.id}" tabindex="0">
        <td><span class="strong mono">${r.bookingReference}</span>${r.unreadNotifications ? html` <span class="badge badge-amber">New</span>` : ""}<div class="sub mono">${r.reservationCode} · #${r.id}</div></td>
        <td>${r.guestName}</td>
        <td>${roomCell(r)}</td>
        <td class="nowrap">${date(r.checkInDate)}</td>
        <td class="nowrap">${date(r.checkOutDate)}<div class="sub">${r.nights} night${r.nights === 1 ? "" : "s"}</div></td>
        <td>${r.numGuests}</td>
        <td>${badge(r.status, STATUS_TEXT[r.status])}<div class="sub">${r.bookingStatus ? r.bookingStatus.replace("_", " ").toLowerCase() : ""}</div></td>
        <td class="nowrap">${dateTime(r.receivedAt)}</td>
        <td>${syncBadge(r.sync)}</td>
      </tr>`
    )}</tbody></table></div>${pagerHTML(meta)}`;
}

function issuesTable(data, meta) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr><th>When</th><th>Type</th><th>Booking ref.</th><th>Guest</th><th>Room</th><th>What happened</th></tr></thead>
    <tbody>${data.map(
      (n) => html`<tr class="${n.reservationId ? "clickable" : ""} ${n.read ? "" : "row-new"}" ${n.reservationId ? html`data-open="${n.reservationId}" tabindex="0"` : ""} data-note="${n.id}">
        <td class="nowrap">${dateTime(n.createdAt)}${n.read ? "" : html`<div><span class="badge badge-amber">New</span></div>`}</td>
        <td>${categoryBadge(n.category)}</td>
        <td class="mono">${n.bookingReference || "—"}</td>
        <td>${n.guestName || "—"}</td>
        <td>${n.roomNumber || "—"}</td>
        <td class="small">${n.message}${n.details?.conflict_with ? html`<div class="sub">Held by ${n.details.conflict_with.booking_reference || n.details.conflict_with.reservation_code} (${date(n.details.conflict_with.check_in)} → ${date(n.details.conflict_with.check_out)})</div>` : ""}</td>
      </tr>`
    )}</tbody></table></div>${pagerHTML(meta)}`;
}

async function load({ quiet = false } = {}) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  $("#filters").classList.toggle("hidden", state.view === "issues");
  if (!quiet) setHTML(results, loadingHTML());
  try {
    if (state.view === "issues") {
      const { data, meta } = await api.list("/notifications", { problems: true, page: state.page, limit: 25 });
      setHTML(results, data.length ? issuesTable(data, meta) : emptyHTML("No synchronisation problems", "Room conflicts and refused StayBook requests will appear here."));
      // Viewing the list marks these problem notifications read for you.
      const unread = data.filter((n) => !n.read);
      if (unread.length) {
        await Promise.all(unread.map((n) => api.post(`/notifications/${n.id}/read`)));
        refreshNotifications();
      }
      return;
    }
    const { data, meta } = await api.list("/online-reservations", { ...state.filters, view: state.view, page: state.page });
    const filtered = Object.values(state.filters).some(Boolean);
    setHTML(results, data.length ? reservationsTable(data, meta) : emptyHTML("No online reservations found", filtered ? "Try different filters." : "Bookings made on StayBook will appear here."));
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

// ── Details ─────────────────────────────────────────────────────────────────

function historyHTML(h) {
  const items = [
    ...h.events.map((e) => ({
      at: e.occurredAt,
      text: html`<strong>${EVENT_TEXT[e.type] || e.type}</strong> <span class="muted">by ${e.origin === "STAYBOOK" ? "StayBook" : "the front desk"}</span>
        <div class="sub">${e.roomNumber ? `Room ${e.roomNumber} · ` : ""}${e.checkInDate ? `${date(e.checkInDate)} → ${date(e.checkOutDate)}` : ""}${e.numGuests ? ` · ${e.numGuests} guest(s)` : ""}${e.status ? ` · ${STATUS_TEXT[e.status] || e.status}` : ""}</div>`,
    })),
    ...h.webhooks.map((w) => ({
      at: w.sentAt || w.createdAt,
      text: html`<strong>Sent to StayBook: ${w.event}</strong> ${badge(w.status)}${w.lastError ? html`<div class="sub">${w.attempts} attempt(s) · ${w.lastError}</div>` : ""}`,
    })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!items.length) return html`<p class="muted">No history recorded.</p>`;
  return html`<ul class="timeline history">${items.map((i) => html`<li><span class="nowrap small muted">${dateTime(i.at)}</span><span>${i.text}</span></li>`)}</ul>`;
}

async function openDetails(id) {
  setQueryParam("open", id);
  try {
    const r = await api.get(`/online-reservations/${id}`);
    // Opening the details marks this reservation's notifications read for you.
    if (r.unreadNotifications) api.post("/notifications/read-all", { reservationId: r.id }).then(() => refreshNotifications()).catch(() => {});
    await openModal({
      title: `Online reservation ${r.bookingReference}`,
      wide: true,
      cancelLabel: "Close",
      submitLabel: "Open reservation",
      body: html`
        ${r.status === "CANCELLED" ? html`<div class="alert alert-danger">Cancelled ${dateTime(r.cancelledAt)}${r.cancellationReason ? ` — ${r.cancellationReason}` : ""}. The room is no longer held for these dates.</div>` : ""}
        ${r.status === "CONFIRMED" && r.room ? html`<div class="alert alert-info">Room <strong>${r.room.roomNumber}</strong> is held for this guest from ${date(r.checkInDate)} to ${date(r.checkOutDate)}. It cannot be given to another guest for overlapping dates.</div>` : ""}
        ${r.sync.health === "WEBHOOK_FAILED" ? html`<div class="alert alert-warning">A front-desk change (${r.sync.outbound.event}) did not reach StayBook: ${r.sync.outbound.lastError || "no answer"}. An administrator can re-send it from Admin Console → Integrations.</div>` : ""}
        <div class="grid grid-2">
          <dl class="dl small">
            <dt>StayBook ref.</dt><dd class="mono">${r.bookingReference}</dd>
            <dt>StayBook booking id</dt><dd class="mono">${r.sourceBookingId}</dd>
            <dt>Frontdesk reservation</dt><dd class="mono">${r.reservationCode} (#${r.id})</dd>
            <dt>Guest</dt><dd>${r.guestName}</dd>
            <dt>Room</dt><dd>${r.room ? `Room ${r.room.roomNumber} · ${r.room.roomType}` : `Unassigned · ${r.roomType}`}${r.roomChangedByFrontDesk ? html`<div class="sub">Booked on StayBook as room ${r.bookedRoomNumber}; moved by the front desk</div>` : ""}</dd>
            <dt>Stay</dt><dd>${date(r.checkInDate)} → ${date(r.checkOutDate)} (${r.nights} night${r.nights === 1 ? "" : "s"})</dd>
            <dt>Guests</dt><dd>${r.numGuests}</dd>
          </dl>
          <dl class="dl small">
            <dt>Status</dt><dd>${badge(r.status, STATUS_TEXT[r.status])}</dd>
            <dt>StayBook status</dt><dd>${badge(r.bookingStatus)}</dd>
            <dt>Quoted price</dt><dd>${money(r.quote.totalAmount)} <span class="muted">(${money(r.quote.nightlyRate)}/night)</span></dd>
            <dt>Payment</dt><dd>${r.paymentMode === "SIMULATED" ? "Simulated online — collect at the front desk" : r.paymentMode}</dd>
            <dt>Received</dt><dd>${dateTime(r.receivedAt)}</dd>
            <dt>Synchronisation</dt><dd>${syncBadge(r.sync)}</dd>
          </dl>
        </div>
        <h3 class="section-title">History</h3>
        ${historyHTML(r.history)}
        ${r.history.notifications.length ? html`<h3 class="section-title">Notifications</h3><ul class="timeline history">${r.history.notifications.map((n) => html`<li><span class="nowrap small muted">${dateTime(n.createdAt)}</span><span>${categoryBadge(n.category)} <span class="small">${n.message}</span></span></li>`)}</ul>` : ""}`,
      onSubmit: async () => {
        window.location.href = `/front-desk/reservations/${r.id}`;
        return true;
      },
    });
  } catch (err) {
    toastError(err);
  } finally {
    setQueryParam("open", "");
    load({ quiet: true });
  }
}

// ── Events ──────────────────────────────────────────────────────────────────

root.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    state.view = tab.dataset.view;
    state.page = 1;
    setQueryParam("view", state.view);
    return load();
  }
  const pageBtn = e.target.closest("button[data-goto-page]");
  if (pageBtn) {
    state.page = Number(pageBtn.dataset.gotoPage);
    return load();
  }
  const row = e.target.closest("tr[data-open]");
  if (row) return openDetails(Number(row.dataset.open));
  return undefined;
});
root.addEventListener("keydown", (e) => {
  const row = e.target.closest?.("tr[data-open]");
  if (row && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    openDetails(Number(row.dataset.open));
  }
});

const applyFilters = () => {
  const form = $("#filters");
  for (const f of FILTERS) {
    state.filters[f] = form.elements[f].value.trim();
    setQueryParam(f, state.filters[f]);
  }
  state.page = 1;
  load();
};
$("#filters").addEventListener("input", debounce(applyFilters));
$("#filters").addEventListener("change", applyFilters);
$("#filters").addEventListener("submit", (e) => e.preventDefault());
$("#clear-filters").addEventListener("click", () => {
  const form = $("#filters");
  for (const f of FILTERS) form.elements[f].value = "";
  applyFilters();
});

// New notifications arrive with the 30-second poll: refresh the list and the issues count.
document.addEventListener("notifications:summary", (e) => {
  const s = e.detail;
  const count = $("#issues-count");
  if (count) {
    count.textContent = String(s.problems);
    count.classList.toggle("hidden", !s.problems);
  }
  if (lastUnread !== null && s.unread > lastUnread && !document.querySelector(".modal-backdrop")) load({ quiet: true });
  lastUnread = s.unread;
});

load();
const toOpen = Number(queryParam("open"));
if (toOpen > 0) openDetails(toOpen);

