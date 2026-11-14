import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, date, badge, errorHTML, emptyHTML, loadingHTML, pagerHTML, debounce, queryParam, setQueryParam } from "../core/ui.js";
import { startNewReservation } from "../core/reservationForm.js";

const root = $("#page-root");
const VIEWS = [
  ["arrivals", "Arrivals"],
  ["departures", "Departures"],
  ["in-house", "In-house"],
  ["upcoming", "Upcoming"],
  ["", "All"],
];
const state = {
  view: queryParam("view") ?? (queryParam("search") ? "" : "arrivals"),
  search: queryParam("search") || "",
  status: "",
  page: 1,
};

setHTML(
  root,
  html`<div class="card">
    <div class="tabs" role="tablist">${VIEWS.map(([v, l]) => html`<button class="tab" data-view="${v}" role="tab">${l}</button>`)}</div>
    <div class="toolbar">
      <input type="search" id="search" placeholder="Code, guest name, room or external ref…" value="${state.search}" aria-label="Search">
      <select id="status" aria-label="Status"><option value="">Any status</option>
        <option value="CONFIRMED">Confirmed</option><option value="CHECKED_IN">Checked in</option>
        <option value="CHECKED_OUT">Checked out</option><option value="CANCELLED">Cancelled</option></select>
    </div>
    <div id="results"></div>
  </div>`
);
const results = $("#results");

const nextAction = (r) => {
  if (r.status === "CONFIRMED") return r.room ? "Verify & check in" : "Assign room";
  if (r.status === "CHECKED_IN") return "Open folio";
  return "View";
};

async function load() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
  $("#status").disabled = !!state.view;
  setHTML(results, loadingHTML());
  try {
    const { data, meta } = await api.list("/reservations", {
      view: state.view,
      search: state.search,
      status: state.view ? "" : state.status,
      page: state.page,
    });
    if (!data.length) {
      setHTML(results, emptyHTML("No reservations found", state.search ? "Try a different search." : "Nothing in this view right now."));
      return;
    }
    setHTML(
      results,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Code</th><th>Guest</th><th>Stay</th><th>Room</th><th>Guests</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.map(
          (r) => html`<tr class="clickable" data-href="${r.status === "CHECKED_IN" && r.stay ? `/front-desk/stays/${r.stay.id}` : `/front-desk/reservations/${r.id}`}">
            <td class="strong mono">${r.reservationCode}</td>
            <td>${r.guest.fullName}<div class="sub">${r.guest.phone || r.guest.email || ""}</div></td>
            <td class="nowrap">${date(r.checkInDate)} → ${date(r.checkOutDate)}<div class="sub">${r.nights} night${r.nights === 1 ? "" : "s"}</div></td>
            <td>${r.room ? html`<strong>${r.room.roomNumber}</strong>` : html`<span class="badge badge-amber plain">Unassigned</span>`}<div class="sub">${r.roomType}</div></td>
            <td>${r.numGuests}</td>
            <td>${badge(r.source, r.source === "RESERVATION_SYSTEM" ? "Online" : "Front desk")}</td>
            <td>${badge(r.status)}</td>
            <td class="right"><span class="btn btn-sm">${nextAction(r)}</span></td>
          </tr>`
        )}</tbody></table></div>${pagerHTML(meta)}`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

root.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    state.view = tab.dataset.view;
    state.page = 1;
    setQueryParam("view", state.view || "all");
    return load();
  }
  const pageBtn = e.target.closest("button[data-goto-page]");
  if (pageBtn) {
    state.page = Number(pageBtn.dataset.gotoPage);
    return load();
  }
  const row = e.target.closest("tr[data-href]");
  if (row) window.location.href = row.dataset.href;
});

$("#search").addEventListener(
  "input",
  debounce((e) => {
    state.search = e.target.value.trim();
    state.page = 1;
    if (state.search && state.view) state.view = "";
    setQueryParam("search", state.search);
    load();
  })
);
$("#status").addEventListener("change", (e) => {
  state.status = e.target.value;
  state.page = 1;
  load();
});

// Same action as the Ctrl/Cmd + A shortcut (registered in core/shell.js).
$("#new-reservation")?.addEventListener("click", () => startNewReservation());

if (state.view === "all") state.view = "";
load();
