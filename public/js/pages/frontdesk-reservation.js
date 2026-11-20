/**
 * Reservation detail — drives the first half of the lifecycle (Figure 13):
 * Confirmed → Verifying Identity (retry until verified) → Checked-In.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, raw, setHTML, date, dateTime, badge, money, label, errorHTML, emptyHTML, openModal, confirmDialog, withBusy, toast, toastError, session, isRoomReady, roomStatusBadge } from "../core/ui.js";
import { lifecycleStepper } from "../core/lifecycle.js";
import { changeRoom } from "../core/roomPicker.js";
import { syncBadge } from "../core/online.js";
import { refreshNotifications } from "../core/notifications.js";

const root = $("#page-root");
const id = session.entityId;
let r;
let online = null; // StayBook booking details, when this reservation came from StayBook

const ID_TYPES = [
  ["PASSPORT", "Passport"],
  ["DRIVERS_LICENSE", "Driver's license"],
  ["NATIONAL_ID", "National ID"],
  ["OTHER_GOVERNMENT_ID", "Other government ID"],
];

function nextStep() {
  if (r.status === "CANCELLED") return html`<div class="alert alert-danger">Cancelled ${dateTime(r.cancelledAt)}${r.cancellationReason ? ` — ${r.cancellationReason}` : ""}.</div>`;
  if (r.status === "CHECKED_IN" || r.status === "CHECKED_OUT") {
    return html`<div class="action-panel"><h3>${r.status === "CHECKED_IN" ? "Guest is in-house" : "Stay completed"}</h3>
      <p class="muted">Billing, payment and checkout are handled on the guest folio.</p>
      <a class="btn btn-primary" href="/front-desk/stays/${r.stay.id}">Open guest folio</a></div>`;
  }
  if (!session.isReceptionist) return html`<div class="alert alert-info">Front-desk actions are performed by receptionists.</div>`;

  const today = new Date().toLocaleDateString("en-CA");
  const roomReady = r.room && isRoomReady(r.room);
  const checks = [
    [!!r.room, r.room ? `Room ${r.room.roomNumber} assigned` : "Assign a room"],
    ...(r.room?.status === "MAINTENANCE" ? [[false, `Room ${r.room.roomNumber} is under maintenance — change the room`]] : []),
    [!r.room || !r.room.needsCleaning, r.room?.needsCleaning ? `Room ${r.room.roomNumber} is ${r.room.status === "CLEANING" ? "being cleaned" : "waiting for housekeeping"}` : "Room is clean"],
    [!r.room || r.room.status !== "OCCUPIED", r.room?.status === "OCCUPIED" ? `Room ${r.room.roomNumber} is still occupied` : "Room is vacant"],
    [r.identityVerified, r.identityVerified ? "Identity verified" : "Verify the guest's identity"],
    [r.checkInDate <= today, r.checkInDate <= today ? "Arrival date reached" : `Arrival on ${date(r.checkInDate)}`],
  ];
  const ready = checks.every(([ok]) => ok);
  return html`<div class="action-panel">
    <h3>Next step: ${!r.room ? "assign a room" : !r.identityVerified ? "verify identity" : "check in"}</h3>
    <ul class="timeline">${checks.map(([ok, text]) => html`<li><span class="check-indicator ${ok ? "ok" : ""}" aria-hidden="true"></span><span class="sr-only">${ok ? "Done:" : "To do:"}</span><span>${text}</span></li>`)}</ul>
    <div class="row" >
      <button class="btn ${r.room ? "" : "btn-primary"}" data-action="assign">${r.room ? "Change room" : "Assign room"}</button>
      ${r.room?.needsCleaning ? html`<button class="btn" data-action="clean">Mark room ${r.room.roomNumber} clean</button>` : ""}
      <button class="btn ${r.room && !r.identityVerified ? "btn-primary" : ""}" data-action="verify">${r.verifications.length ? "Retry verification" : "Verify identity"}</button>
      <button class="btn btn-success" data-action="checkin" ${ready && roomReady ? "" : raw("disabled")}>Check in guest</button>
    </div></div>`;
}

function render() {
  $(".page-head h1").textContent = `Reservation ${r.reservationCode}`;
  $(".page-head p").textContent = `${r.guest.fullName} · ${date(r.checkInDate)} → ${date(r.checkOutDate)}`;

  setHTML(
    root,
    html`
    <div class="card" >${lifecycleStepper(r)}</div>
    <div class="grid grid-main" id="detail-grid">
      <div class="stack">
        ${nextStep()}
        <div class="card"><div class="card-head"><h2>Reservation</h2>${badge(r.status)}</div>
          <div class="card-body"><dl class="dl">
            <dt>Code</dt><dd class="mono">${r.reservationCode}</dd>
            <dt>Dates</dt><dd>${date(r.checkInDate)} → ${date(r.checkOutDate)} (${r.nights} night${r.nights === 1 ? "" : "s"})</dd>
            <dt>Guests</dt><dd>${r.numGuests}</dd>
            <dt>Room type</dt><dd>${r.roomType}</dd>
            <dt>Source</dt><dd>${online ? "StayBook (online booking)" : r.source === "RESERVATION_SYSTEM" ? "Hotel Reservation System" : "Front desk"}</dd>
            ${r.externalReservationId ? html`<dt>External ID</dt><dd class="mono">${r.externalReservationId}</dd>` : ""}
            ${r.bookingReference ? html`<dt>Booking ref.</dt><dd class="mono">${r.bookingReference}</dd>` : ""}
            ${r.externalPaymentStatus ? html`<dt>Online payment</dt><dd>${label(r.externalPaymentStatus)}</dd>` : ""}
            ${r.notes ? html`<dt>Notes</dt><dd>${r.notes}</dd>` : ""}
            <dt>Created</dt><dd>${dateTime(r.createdAt)}</dd>
          </dl></div></div>
        <div class="card"><div class="card-head"><h2>Identity verification attempts</h2>${r.identityVerified ? badge("VERIFIED") : ""}</div>
          <div class="card-body flush">${
            r.verifications.length
              ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>When</th><th>ID</th><th>Result</th><th>By</th></tr></thead><tbody>
                ${r.verifications.map(
                  (v) => html`<tr><td>${v.attemptNo}</td><td class="nowrap">${dateTime(v.attemptedAt)}</td>
                    <td>${label(v.idType)}<div class="sub">•••• ${v.idNumberLast4}</div></td>
                    <td>${badge(v.result)}${v.failureReason ? html`<div class="sub">${v.failureReason}</div>` : ""}</td>
                    <td>${v.verifiedBy?.fullName || ""}</td></tr>`
                )}</tbody></table></div>`
              : emptyHTML("No attempts yet", "The guest's ID is checked on arrival.")
          }</div></div>
      </div>
      <div class="stack">
        ${online ? stayBookCard() : ""}
        <div class="card"><div class="card-head"><h2>Guest</h2><a class="small" href="/guests/${r.guest.id}">Profile →</a></div>
          <div class="card-body"><dl class="dl">
            <dt>Name</dt><dd>${r.guest.fullName}</dd>
            <dt>Email</dt><dd>${r.guest.email || "—"}</dd>
            <dt>Phone</dt><dd>${r.guest.phone || "—"}</dd>
          </dl></div></div>
        <div class="card"><div class="card-head"><h2>Room</h2>${r.room ? roomStatusBadge(r.room) : ""}</div>
          <div class="card-body">${
            r.room
              ? html`<dl class="dl"><dt>Room</dt><dd>${r.room.roomNumber}</dd><dt>Type</dt><dd>${r.room.roomType}</dd>
                  <dt>Capacity</dt><dd>${r.room.capacity}</dd><dt>Rate</dt><dd>${money(r.room.nightlyRate)} / night</dd>
                  <dt>Housekeeping</dt><dd>${r.room.needsCleaning ? html`<span class="badge badge-amber">${r.room.status === "CLEANING" ? "Cleaning in progress" : "Needs cleaning"}</span>` : html`<span class="badge badge-green">Clean</span>`}</dd></dl>`
              : html`<p class="muted">No room assigned yet.</p>`
          }</div></div>
      </div>
    </div>`
  );
}

/** StayBook booking: reference, quote, synchronisation and a link to its history. */
const stayBookCard = () => html`<div class="card"><div class="card-head"><h2>StayBook online booking</h2>${badge(online.bookingStatus)}</div>
  <div class="card-body"><dl class="dl">
    <dt>StayBook ref.</dt><dd class="mono">${online.bookingReference}</dd>
    <dt>Received</dt><dd>${dateTime(online.receivedAt)}</dd>
    <dt>Quoted price</dt><dd>${money(online.quote.totalAmount)} <span class="muted small">(${money(online.quote.nightlyRate)}/night)</span></dd>
    ${online.roomChangedByFrontDesk ? html`<dt>Booked room</dt><dd>${online.bookedRoomNumber} <span class="muted small">(moved by the front desk)</span></dd>` : ""}
    <dt>Synchronisation</dt><dd>${syncBadge(online.sync)}</dd>
  </dl>
  ${r.status === "CONFIRMED" && r.room ? html`<p class="small muted">Room ${r.room.roomNumber} is held for this guest for ${date(r.checkInDate)} → ${date(r.checkOutDate)} only; other dates stay bookable.</p>` : ""}
  <a class="small" href="/front-desk/online-reservations?open=${r.id}">History &amp; notifications →</a></div></div>`;

async function load() {
  try {
    r = await api.get(`/reservations/${id}`);
    online = null;
    if (r.source === "RESERVATION_SYSTEM") {
      // 404 = an online booking from the older type-based Booking API, not StayBook.
      online = await api.get(`/online-reservations/${id}`).catch(() => null);
      if (online?.unreadNotifications) api.post("/notifications/read-all", { reservationId: id }).then(() => refreshNotifications()).catch(() => {});
    }
    render();
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

async function assignRoom() {
  const result = await changeRoom(r);
  if (result) {
    toast(`Room ${result.room.roomNumber} assigned to ${result.reservationCode}.`, "success");
    r = result;
    render();
  }
}

async function verify() {
  const attempt = await openModal({
    title: "Verify guest identity",
    submitLabel: "Validate ID",
    body: html`<p class="muted">Check the physical ID against the guest in front of you. Only the ID type and the last 4 characters are stored.</p>
      <div class="field-row">
        <div class="field"><label>ID type</label><select name="idType" required>${ID_TYPES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
        <div class="field"><label>Last 4 of ID number</label><input name="idNumberLast4" required minlength="4" maxlength="4" pattern="[A-Za-z0-9]{4}" autocomplete="off"></div>
      </div>
      <div class="field"><label>Full name exactly as printed on the ID</label><input name="nameOnId" required maxlength="160" autocomplete="off"></div>
      <div class="field"><label>ID expiry date</label><input name="expiryDate" type="date" required></div>
      <div class="field"><label class="check"><input type="checkbox" name="photoMatches"> The photo on the ID matches the guest</label></div>`,
    onSubmit: (values) => api.post("/verifications", { ...values, reservationId: id }),
  });
  if (!attempt) return;
  if (attempt.result === "VERIFIED") toast(`Attempt ${attempt.attemptNo}: identity verified.`, "success");
  else toast(`Attempt ${attempt.attemptNo} failed: ${attempt.failureReason}. You can retry.`, "warning", 8000);
  load();
}

async function checkIn(button) {
  if (!(await confirmDialog(`Check in ${r.guest.fullName} to room ${r.room.roomNumber}?`, { confirmLabel: "Check in" }))) return;
  await withBusy(button, async () => {
    const stay = await api.post("/check-ins", { reservationId: id });
    toast(`${r.guest.fullName} checked in to room ${r.room.roomNumber}.`, "success");
    window.location.href = `/front-desk/stays/${stay.id}`;
  });
}

document.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-action]");
  if (!button || !r) return;
  try {
    switch (button.dataset.action) {
      case "assign":
        return await assignRoom();
      case "verify":
        return await verify();
      case "checkin":
        return await checkIn(button);
      case "clean":
        await withBusy(button, () => api.post(`/rooms/${r.room.id}/clean`));
        toast(`Room ${r.room.roomNumber} marked clean.`, "success");
        return load();
      default:
        return undefined;
    }
  } catch (err) {
    toastError(err);
    if (err.status === 409) load();
  }
});

load();
