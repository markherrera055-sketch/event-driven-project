import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, date, dateTime, badge, errorHTML, emptyHTML, loadingHTML, debounce } from "../core/ui.js";

const root = $("#page-root");
const state = { status: "IN_HOUSE", search: "" };

setHTML(
  root,
  html`<div class="card">
    <div class="tabs"><button class="tab" data-status="IN_HOUSE">In-house</button><button class="tab" data-status="CHECKED_OUT">Checked out</button></div>
    <div class="toolbar"><input type="search" id="search" placeholder="Guest, room or reservation code…" aria-label="Search"></div>
    <div id="results"></div></div>`
);
const results = $("#results");
const todayIso = new Date().toLocaleDateString("en-CA");

const billState = (s) => {
  if (!s.bill) return s.status === "IN_HOUSE" ? html`<span class="muted">Not generated</span>` : "—";
  return badge(s.bill.status, s.bill.status === "CONFIRMED" ? "Awaiting payment" : undefined);
};

async function load() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.status === state.status));
  setHTML(results, loadingHTML());
  try {
    const stays = await api.get("/stays", state);
    if (!stays.length) return setHTML(results, emptyHTML(state.status === "IN_HOUSE" ? "No guests in-house" : "No checked-out stays", ""));
    setHTML(
      results,
      html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Room</th><th>Guest</th><th>Reservation</th><th>Checked in</th><th>${state.status === "IN_HOUSE" ? "Expected checkout" : "Checked out"}</th><th>Bill</th><th></th></tr></thead>
        <tbody>${stays.map((s) => {
          const r = s.reservation;
          const overdue = s.status === "IN_HOUSE" && r.checkOutDate < todayIso;
          return html`<tr class="clickable" data-href="/front-desk/stays/${s.id}">
            <td class="strong">${r.room.roomNumber}<div class="sub">${r.room.roomType}</div></td>
            <td>${r.guest.fullName}</td>
            <td class="mono">${r.reservationCode}</td>
            <td class="nowrap">${dateTime(s.checkInAt)}</td>
            <td class="nowrap">${s.status === "IN_HOUSE" ? html`${date(r.checkOutDate)} ${overdue ? html`<span class="badge badge-red plain">Overdue</span>` : ""}` : dateTime(s.checkOutAt)}</td>
            <td>${billState(s)}</td>
            <td class="right"><span class="btn btn-sm">Open folio</span></td></tr>`;
        })}</tbody></table></div><div class="pager"><span>${stays.length} stay(s)</span></div>`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

root.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    state.status = tab.dataset.status;
    return load();
  }
  const row = e.target.closest("tr[data-href]");
  if (row) window.location.href = row.dataset.href;
});
$("#search").addEventListener("input", debounce((e) => { state.search = e.target.value.trim(); load(); }));
load();
