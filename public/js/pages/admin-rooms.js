/** Admin Console — Administrator.manageRooms() (DFD 10.0): add, edit, delete / archive, restore. */
import "../core/shell.js";
import { api, ApiError } from "../core/api.js";
import { $, html, raw, setHTML, money, dateTime, errorHTML, emptyHTML, loadingHTML, openModal, toast, toastError, roomStatusBadge, roomDisplayStatus, formValues, debounce } from "../core/ui.js";

const root = $("#page-root");
setHTML(
  root,
  html`<div class="card"><div class="toolbar between">
    <input type="search" id="search" placeholder="Room number…" aria-label="Search rooms">
    <label class="check"><input type="checkbox" id="show-deleted"> Show deleted rooms</label>
  </div><div id="results"></div></div>`
);
const results = $("#results");
let rooms = [];
let types = [];
const showDeleted = () => $("#show-deleted").checked;

// Status choices an administrator can make. Occupied (check-in) and Reserved
// (derived from reservations) are never set by hand.
const STATUS_CHOICES = [
  ["AVAILABLE", "Available", "Can be assigned to reservations."],
  ["MAINTENANCE", "Under maintenance", "Temporarily unavailable: cannot be assigned or checked into."],
  ["INACTIVE", "Inactive (out of service)", "Removed from inventory and availability."],
];

const statusField = (room) => {
  if (room.status === "OCCUPIED") {
    return html`<div class="field"><label>Status</label><select disabled><option>Occupied</option></select>
      <div class="hint">Occupied by an in-house guest. The status changes automatically at checkout or room move.</div></div>`;
  }
  const current = room.id ? (room.isActive === false ? "INACTIVE" : room.status === "MAINTENANCE" ? "MAINTENANCE" : "AVAILABLE") : "AVAILABLE";
  return html`<div class="field"><label>Status</label><select name="statusChoice">
    ${STATUS_CHOICES.map(([value, text]) => html`<option value="${value}" ${value === current ? raw("selected") : ""}>${text}</option>`)}
    </select><div class="hint" data-status-hint></div></div>`;
};

const form = (room = {}) => html`
  <div class="field-row">
    <div class="field"><label>Room number</label><input name="roomNumber" value="${room.roomNumber || ""}" required maxlength="10" pattern="[A-Za-z0-9]+(-[A-Za-z0-9]+)*" title="Letters, digits and dashes (e.g. 204 or B-12)"></div>
    <div class="field"><label>Floor <span class="muted">(optional)</span></label><input name="floor" value="${room.floor || ""}" maxlength="10" pattern="[A-Za-z0-9\\-]+" title="e.g. 2, G or M"></div>
  </div>
  <div class="field-row">
    <div class="field"><label>Room type</label><input name="roomType" value="${room.roomType || ""}" required maxlength="50" list="room-types" autocomplete="off">
      <datalist id="room-types">${types.map((t) => html`<option value="${t}">`)}</datalist></div>
    ${statusField(room)}
  </div>
  <div class="field-row">
    <div class="field"><label>Capacity (guests)</label><input name="capacity" type="number" min="1" max="20" value="${room.capacity || 2}" required></div>
    <div class="field"><label>Nightly rate</label><input name="nightlyRate" type="number" min="0.01" max="99999999.99" step="0.01" value="${room.nightlyRate ?? ""}" required></div>
  </div>
  <div class="field"><label>Description <span class="muted">(optional)</span></label><textarea name="description" maxlength="1000" rows="3" placeholder="View, bed configuration, notes for staff…">${room.description || ""}</textarea></div>
  <div class="field"><label>Amenities <span class="muted">(optional)</span></label><input name="amenities" value="${(room.amenities || []).join(", ")}" maxlength="1000" placeholder="Wi-Fi, Air conditioning, Smart TV, Mini bar">
    <div class="hint">Separate with commas.</div></div>`;

const amenityList = (r) =>
  r.amenities?.length
    ? html`<span class="small">${r.amenities.slice(0, 3).join(", ")}${r.amenities.length > 3 ? html` <span class="muted">+${r.amenities.length - 3}</span>` : ""}</span>`
    : html`<span class="muted">—</span>`;

async function load() {
  setHTML(results, loadingHTML());
  try {
    const deleted = showDeleted();
    rooms = await api.get("/rooms", deleted ? { archived: true, search: $("#search").value.trim() } : { includeInactive: true, search: $("#search").value.trim() });
    if (!deleted) types = [...new Set(rooms.map((r) => r.roomType))].sort();
    if (!rooms.length) {
      return setHTML(results, deleted ? emptyHTML("No deleted rooms", "Rooms deleted with past reservations are kept here and can be restored.") : emptyHTML("No rooms yet", "Add the hotel's rooms to start taking reservations."));
    }
    setHTML(
      results,
      html`<div class="table-wrap"><table class="table"><thead><tr><th>Room</th><th>Type</th><th class="right">Capacity</th><th class="right">Nightly rate</th><th>Amenities</th><th>Status</th><th></th></tr></thead><tbody>
      ${rooms.map((r) => html`<tr>
        <td class="strong">${r.roomNumber}${r.floor ? html`<div class="sub">Floor ${r.floor}</div>` : ""}</td>
        <td>${r.roomType}</td><td class="num">${r.capacity}</td><td class="num">${money(r.nightlyRate)}</td>
        <td>${amenityList(r)}</td>
        <td>${roomStatusBadge(r)}
          ${r.reservedTonight ? html`<div class="sub">${r.reservedTonight.reservationCode} · ${r.reservedTonight.guestName}</div>` : ""}
          ${r.currentReservation ? html`<div class="sub">${r.currentReservation.guestName}</div>` : ""}
          ${r.archivedAt ? html`<div class="sub">Deleted ${dateTime(r.archivedAt)}</div>` : ""}</td>
        <td class="right"><div class="row">${deleted
          ? html`<button class="btn btn-sm" data-restore="${r.id}">Restore</button>`
          : html`<button class="btn btn-sm" data-edit="${r.id}">Edit</button>
                 <button class="btn btn-sm btn-ghost-danger" data-delete="${r.id}" ${r.status === "OCCUPIED" ? raw('disabled title="Occupied rooms cannot be deleted"') : ""}>Delete</button>`}</div></td></tr>`)}
      </tbody></table></div><div class="pager"><span>${rooms.length} room(s)</span></div>`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

/** Form values → API payload. Empty optional fields are sent as "" so an edit can clear them. */
function toPayload(v, room = {}) {
  const payload = {
    roomNumber: v.roomNumber,
    roomType: v.roomType,
    floor: v.floor ?? "",
    capacity: Number(v.capacity),
    nightlyRate: Number(v.nightlyRate).toFixed(2),
    description: v.description ?? "",
    amenities: v.amenities ?? "",
  };
  if (room.status !== "OCCUPIED" && v.statusChoice) {
    if (v.statusChoice === "INACTIVE") payload.isActive = false;
    else Object.assign(payload, { isActive: true, status: v.statusChoice === "MAINTENANCE" ? "MAINTENANCE" : "VACANT" });
  }
  return payload;
}

/** Client-side check against the loaded list (the server is still the authority). */
function assertUniqueNumber(v, room = {}) {
  const n = String(v.roomNumber || "").toLowerCase();
  if (rooms.some((r) => r.id !== room.id && r.roomNumber.toLowerCase() === n)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Some fields are invalid.", { roomNumber: `Room ${v.roomNumber} already exists.` });
  }
}

const bindStatusHint = (f) => {
  const select = f.querySelector('[name="statusChoice"]');
  const hint = f.querySelector("[data-status-hint]");
  if (!select || !hint) return;
  const sync = () => (hint.textContent = STATUS_CHOICES.find(([value]) => value === select.value)?.[2] || "");
  select.addEventListener("change", sync);
  sync();
};

const maintenanceWarning = (saved) => {
  if (saved.upcomingReservations > 0) {
    toast(`Room ${saved.roomNumber} is under maintenance. ${saved.upcomingReservations} upcoming reservation(s) are still assigned to it — reassign them if the work is not finished in time.`, "warning", 9000);
  }
};

$("#new-room")?.addEventListener("click", async () => {
  try {
    const created = await openModal({
      title: "Add room",
      submitLabel: "Add room",
      wide: true,
      body: form(),
      onOpen: bindStatusHint,
      onSubmit: (_v, f) => {
        const v = formValues(f, { keepEmpty: true });
        assertUniqueNumber(v);
        return api.post("/admin/rooms", toPayload(v));
      },
    });
    if (created) {
      toast(`Room ${created.roomNumber} added.`, "success");
      if (showDeleted()) $("#show-deleted").checked = false;
      load();
    }
  } catch (err) {
    toastError(err);
  }
});

async function editRoom(room) {
  const updated = await openModal({
    title: `Edit room ${room.roomNumber}`,
    submitLabel: "Save changes",
    wide: true,
    body: form(room),
    onOpen: bindStatusHint,
    onSubmit: (_v, f) => {
      const v = formValues(f, { keepEmpty: true });
      assertUniqueNumber(v, room);
      return api.patch(`/admin/rooms/${room.id}`, toPayload(v, room));
    },
  });
  if (updated) {
    toast(`Room ${updated.roomNumber} saved.`, "success");
    maintenanceWarning(updated);
    load();
  }
}

async function deleteRoom(room) {
  const result = await openModal({
    title: `Delete room ${room.roomNumber}?`,
    submitLabel: "Delete room",
    danger: true,
    body: html`<p>Room <strong>${room.roomNumber}</strong> (${room.roomType}) will be removed from inventory.</p>
      <ul class="notes">
        <li>Rooms that are occupied or have active reservations cannot be deleted — reassign or cancel those first.</li>
        <li>If the room has past reservations, it is <strong>archived</strong> instead of permanently deleted: their stays, bills and receipts stay intact, and the room can be restored later.</li>
        <li>A room that was never booked is deleted permanently.</li>
      </ul>`,
    onSubmit: () => api.delete(`/admin/rooms/${room.id}`),
  });
  if (!result) return;
  toast(
    result.mode === "archived"
      ? `Room ${room.roomNumber} archived. ${result.historicalReservations} past reservation(s) were kept.`
      : `Room ${room.roomNumber} deleted.`,
    "success"
  );
  load();
}

async function restoreRoom(room) {
  const restored = await openModal({
    title: `Restore room ${room.roomNumber}?`,
    submitLabel: "Restore room",
    body: html`<p>The room returns to inventory as <strong>${roomDisplayStatus({ ...room, archivedAt: null, isActive: true }) === "MAINTENANCE" ? "Under maintenance" : "Available"}</strong> and can be assigned to reservations again.</p>`,
    onSubmit: () => api.post(`/admin/rooms/${room.id}/restore`),
  });
  if (restored) {
    toast(`Room ${restored.roomNumber} restored.`, "success");
    load();
  }
}

results.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-edit], [data-delete], [data-restore]");
  if (!btn || btn.disabled) return;
  const room = rooms.find((r) => r.id === Number(btn.dataset.edit || btn.dataset.delete || btn.dataset.restore));
  if (!room) return;
  try {
    if (btn.dataset.edit) await editRoom(room);
    else if (btn.dataset.delete) await deleteRoom(room);
    else await restoreRoom(room);
  } catch (err) {
    toastError(err);
  }
});
$("#search").addEventListener("input", debounce(load, 300));
$("#show-deleted").addEventListener("change", load);
load();
