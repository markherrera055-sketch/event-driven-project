/** Room Status module (live board) + light housekeeping (mark clean). */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, money, date, dateTime, errorHTML, emptyHTML, loadingHTML, withBusy, toast, toastError, queryParam, roomStatusBadge } from "../core/ui.js";

const root = $("#page-root");
const state = { filter: queryParam("housekeeping") === "dirty" ? "dirty" : "all", roomType: "" };

setHTML(
  root,
  html`<div class="card">
    <div class="tabs">
      <button class="tab" data-filter="all">All rooms</button><button class="tab" data-filter="vacant">Vacant</button>
      <button class="tab" data-filter="occupied">Occupied</button><button class="tab" data-filter="dirty">Needs cleaning</button>
      <button class="tab" data-filter="maintenance">Maintenance</button>
    </div>
    <div class="toolbar between"><select id="type" aria-label="Room type"><option value="">All room types</option></select>
      <div class="legend"><span><i class="l-vacant"></i>Vacant &amp; clean</span><span><i class="l-reserved"></i>Reserved tonight</span><span><i class="l-occupied"></i>Occupied</span><span><i class="l-dirty"></i>Needs cleaning</span><span><i class="l-maintenance"></i>Maintenance</span></div></div>
    <div id="board"></div></div>`
);
const board = $("#board");

const params = () => ({
  roomType: state.roomType,
  status: { vacant: "VACANT", occupied: "OCCUPIED", maintenance: "MAINTENANCE" }[state.filter],
  needsCleaning: state.filter === "dirty" ? true : undefined,
});

async function load() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === state.filter));
  setHTML(board, loadingHTML());
  try {
    const rooms = await api.get("/rooms", params());
    if (!rooms.length) return setHTML(board, emptyHTML("No rooms match this filter"));
    setHTML(
      board,
      html`<div class="room-board">${rooms.map((r) => {
        const cls = r.status === "OCCUPIED" ? "occupied" : r.status === "MAINTENANCE" ? "maintenance" : r.needsCleaning ? "dirty" : r.reservedTonight ? "reserved" : "";
        return html`<div class="room-tile ${cls}">
          <div class="row between"><span class="no">${r.roomNumber}</span>${roomStatusBadge(r)}</div>
          <div class="type">${r.roomType}${r.floor ? ` · Floor ${r.floor}` : ""} · ${r.capacity} pax · ${money(r.nightlyRate)}</div>
          ${r.currentReservation ? html`<div class="guest">${r.currentReservation.guestName}<div class="sub muted">Out ${date(r.currentReservation.checkOutDate)}</div></div>` : ""}
          ${!r.currentReservation && r.reservedTonight ? html`<div class="guest">${r.reservedTonight.guestName}<div class="sub muted">Arriving · ${r.reservedTonight.reservationCode}</div></div>` : ""}
          <div class="foot">
            ${r.needsCleaning
              ? html`<span class="badge badge-amber">Needs cleaning</span><button class="btn btn-sm" data-clean="${r.id}" data-no="${r.roomNumber}">Mark clean</button>`
              : html`<span class="small muted">${r.lastCleanedAt ? `Cleaned ${dateTime(r.lastCleanedAt)}` : "Clean"}</span>`}
          </div></div>`;
      })}</div>`
    );
  } catch (err) {
    setHTML(board, errorHTML(err));
  }
}

root.addEventListener("click", async (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    state.filter = tab.dataset.filter;
    return load();
  }
  const clean = e.target.closest("[data-clean]");
  if (clean) {
    try {
      await withBusy(clean, () => api.post(`/rooms/${clean.dataset.clean}/clean`));
      toast(`Room ${clean.dataset.no} is clean and ready.`, "success");
      load();
    } catch (err) {
      toastError(err);
    }
  }
  return undefined;
});
$("#type").addEventListener("change", (e) => { state.roomType = e.target.value; load(); });

api.get("/room-types").then((types) => {
  $("#type").insertAdjacentHTML("beforeend", String(html`${types.map((t) => html`<option value="${t.roomType}">${t.roomType} (${t.roomCount})</option>`)}`));
}).catch(() => {});
load();
