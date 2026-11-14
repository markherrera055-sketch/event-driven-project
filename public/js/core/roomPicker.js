/**
 * Editable "Assigned room": searchable picker of rooms that are eligible for
 * the reservation's dates, followed by a confirmation step. Used by the
 * reservation page (assign / change before arrival) and the guest folio
 * (room move for an in-house guest).
 *
 * Eligibility comes from the server (dates, overlapping bookings, capacity,
 * maintenance, physical occupancy, type capacity). Before saving, the list is
 * re-fetched to confirm the room is still free, and the server re-checks
 * everything again under row locks when the change is committed.
 */
import { api, ApiError } from "./api.js";
import { html, setHTML, money, date, openModal, roomStatusBadge } from "./ui.js";

const nightsText = (n) => `${n} night${n === 1 ? "" : "s"}`;

function optionRow(room, current, reservation, inHouse) {
  const typeChange = current && room.roomType !== current.roomType;
  const amenities = room.amenities?.length ? room.amenities.slice(0, 4).join(" · ") + (room.amenities.length > 4 ? ` +${room.amenities.length - 4}` : "") : "";
  const search = [room.roomNumber, room.roomType, room.floor ? `floor ${room.floor}` : "", ...(room.amenities || [])].join(" ").toLowerCase();
  return html`<label class="room-option" data-search="${search}">
    <input type="radio" name="roomId" value="${room.id}" required>
    <span class="ro-main"><strong>Room ${room.roomNumber}</strong>
      <span class="sub">${room.roomType}${room.floor ? ` · Floor ${room.floor}` : ""} · up to ${room.capacity}${typeChange ? " · different type" : ""}</span>
      ${amenities ? html`<span class="sub">${amenities}</span>` : ""}</span>
    <span class="ro-status">${roomStatusBadge(room)}${room.needsCleaning ? html`<span class="badge badge-amber plain">Needs cleaning</span>` : ""}</span>
    <span class="ro-rate num">${money(room.nightlyRate)}<span class="sub">per night</span></span>
    <span class="ro-avail"><span class="badge badge-green plain">${inHouse ? "Vacant & clean now" : `Free · ${nightsText(reservation.nights)}`}</span></span>
  </label>`;
}

const listHTML = (rooms, current, reservation, inHouse) =>
  rooms.length
    ? html`${rooms.map((room) => optionRow(room, current, reservation, inHouse))}<p class="muted small no-match hidden">No room matches the search.</p>`
    : html`<div class="empty"><strong>No eligible rooms</strong>${inHouse ? "No other room is vacant, clean and free for the rest of this stay." : "No other room is free for these dates."} Try “Show other room types”.</div>`;

/**
 * changeRoom(reservation) → updated reservation, or null when cancelled.
 * `reservation` needs id, reservationCode, status, checkInDate, checkOutDate, nights, numGuests, room.
 */
export async function changeRoom(reservation) {
  const inHouse = reservation.status === "CHECKED_IN";
  const current = reservation.room;
  const load = (allTypes) => api.get(`/reservations/${reservation.id}/assignable-rooms`, { allTypes });
  let allTypes = false;
  let rooms = await load(false);

  const picked = await openModal({
    title: `${current ? "Change room" : "Assign a room"} · ${reservation.reservationCode}`,
    submitLabel: "Continue",
    wide: true,
    body: html`
      <p class="muted">${inHouse ? "Move the in-house guest to a room that is vacant and clean now and free until" : "Rooms free for"}
        ${inHouse ? html` ${date(reservation.checkOutDate)}` : html` ${date(reservation.checkInDate)} → ${date(reservation.checkOutDate)}`},
        with space for ${reservation.numGuests} guest${reservation.numGuests === 1 ? "" : "s"}. Rooms under maintenance, occupied or booked on any of these nights are not listed.</p>
      ${current ? html`<div class="current-room"><span class="small muted">Current room</span> <strong>Room ${current.roomNumber}</strong> · ${current.roomType} · ${money(current.nightlyRate)}/night</div>` : ""}
      <div class="room-picker-tools">
        <input type="search" id="room-search" placeholder="Search by number, type, floor or amenity…" aria-label="Search rooms" autocomplete="off">
        <label class="check"><input type="checkbox" id="all-types"> Show other room types</label>
      </div>
      <div class="room-options" id="room-list" role="radiogroup" aria-label="Eligible rooms">${listHTML(rooms, current, reservation, inHouse)}</div>`,
    onOpen: (form) => {
      const listEl = form.querySelector("#room-list");
      const search = form.querySelector("#room-search");
      const filter = () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        listEl.querySelectorAll(".room-option").forEach((row) => {
          const match = !q || row.dataset.search.includes(q);
          row.hidden = !match;
          shown += match ? 1 : 0;
        });
        listEl.querySelector(".no-match")?.classList.toggle("hidden", shown > 0);
      };
      search.addEventListener("input", filter);
      // Enter in the search box must not submit the picker.
      search.addEventListener("keydown", (e) => e.key === "Enter" && e.preventDefault());
      form.querySelector("#all-types").addEventListener("change", async (e) => {
        allTypes = e.target.checked;
        setHTML(listEl, html`<div class="loading"><span class="spinner"></span>Loading rooms…</div>`);
        try {
          rooms = await load(allTypes);
          setHTML(listEl, listHTML(rooms, current, reservation, inHouse));
          filter();
        } catch (err) {
          setHTML(listEl, html`<div class="alert alert-danger">${err.message}</div>`);
        }
      });
      search.focus();
    },
    onSubmit: (values) => {
      const room = rooms.find((r) => r.id === Number(values.roomId));
      if (!room) throw new ApiError(422, "VALIDATION_ERROR", "Choose a room from the list.");
      return room;
    },
  });
  if (!picked) return null;

  const rateChange = current && Number(current.nightlyRate) !== Number(picked.nightlyRate);
  return openModal({
    title: "Confirm room change",
    submitLabel: current ? "Confirm change" : "Assign room",
    body: html`
      <div class="room-compare">
        <div><span class="small muted">From</span><strong>${current ? `Room ${current.roomNumber}` : "No room"}</strong><span class="sub">${current ? `${current.roomType} · ${money(current.nightlyRate)}/night` : "Unassigned"}</span></div>
        <div class="arrow" aria-hidden="true">→</div>
        <div><span class="small muted">To</span><strong>Room ${picked.roomNumber}</strong><span class="sub">${picked.roomType} · ${money(picked.nightlyRate)}/night</span></div>
      </div>
      <dl class="dl small">
        <dt>Reservation</dt><dd>${reservation.reservationCode}${reservation.guest ? ` · ${reservation.guest.fullName}` : ""}</dd>
        <dt>Dates</dt><dd>${date(reservation.checkInDate)} → ${date(reservation.checkOutDate)} (${nightsText(reservation.nights)})</dd>
      </dl>
      <ul class="notes">
        ${inHouse
          ? html`<li>Room ${picked.roomNumber} becomes <strong>Occupied</strong>; room ${current?.roomNumber} becomes vacant and is sent to housekeeping.</li>`
          : current ? html`<li>Room ${current.roomNumber} is released for these dates.</li>` : ""}
        <li>Guest details, dates and booking information stay the same${picked.roomType !== reservation.roomType ? html`; the room type changes to <strong>${picked.roomType}</strong>` : ""}.</li>
        ${rateChange ? html`<li>The nightly rate changes from ${money(current.nightlyRate)} to <strong>${money(picked.nightlyRate)}</strong>. ${inHouse ? "The final bill uses the rate of the room at billing time; adjust the bill if needed." : "The bill uses the rate of the assigned room."}</li>` : ""}
      </ul>`,
    onSubmit: async () => {
      // Front-end re-check right before saving; the server re-checks again under lock.
      const stillFree = await api.get(`/reservations/${reservation.id}/assignable-rooms`, { allTypes: true });
      if (!stillFree.some((r) => r.id === picked.id)) {
        throw new ApiError(409, "ROOM_UNAVAILABLE", `Room ${picked.roomNumber} is no longer available. Close this dialog and choose another room.`);
      }
      return api.put(`/reservations/${reservation.id}/room`, { roomId: picked.id });
    },
  });
}

