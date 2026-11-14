/** Walk-in / phone reservation entry (A1): the minimum needed for the PMS to run before the external Hotel Reservation System is connected. */
import { api } from "./api.js";
import { html, openModal, nest, money, toast, toastError } from "./ui.js";

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const plusDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

const roomTypeOptions = (types, selected) =>
  types.map(
    (t) => html`<option value="${t.roomType}" ${t.roomType === selected ? html`selected` : ""}>${t.roomType} — up to ${t.maxCapacity} guests, from ${money(t.minRate)}/night</option>`
  );

export async function openNewReservation() {
  const types = await api.get("/room-types");
  const start = today();
  return openModal({
    title: "New reservation (walk-in / phone)",
    submitLabel: "Create reservation",
    wide: true,
    body: html`
      <fieldset><legend>Guest</legend>
        <div class="field-row">
          <div class="field"><label>First name</label><input name="guest.firstName" required maxlength="80"></div>
          <div class="field"><label>Last name</label><input name="guest.lastName" required maxlength="80"></div>
        </div>
      </fieldset>
      <fieldset><legend>Stay</legend>
        <div class="field-row-3">
          <div class="field"><label>Check-in date</label><input name="checkInDate" type="date" min="${start}" value="${start}" required></div>
          <div class="field"><label>Check-out date</label><input name="checkOutDate" type="date" min="${plusDays(start, 1)}" value="${plusDays(start, 1)}" required></div>
          <div class="field"><label>Guests</label><input name="numGuests" type="number" min="1" max="20" value="1" required></div>
        </div>
        <div class="field"><label>Room type</label>
          <select name="roomType" required>${roomTypeOptions(types)}</select>
          <div class="hint">A specific room can be assigned now or at arrival.</div>
        </div>
      </fieldset>`,
    onOpen: (form) => syncDates(form),
    onSubmit: (values) => api.post("/reservations", nest(values)),
  });
}

let pending = null;

/**
 * "New reservation" action — used by the button on the Reservations page AND
 * by the Ctrl/Cmd + A shortcut, so both run exactly the same code. While the
 * form is loading or open, further triggers are ignored (no duplicate forms).
 */
export function startNewReservation() {
  if (pending) return pending;
  pending = (async () => {
    try {
      const created = await openNewReservation();
      if (created) {
        toast(`Reservation ${created.reservationCode} created.`, "success");
        window.location.href = `/front-desk/reservations/${created.id}`;
      }
    } catch (err) {
      toastError(err);
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Keeps check-out after check-in in the date pickers. */
function syncDates(form) {
  const inEl = form.querySelector('[name="checkInDate"]');
  const outEl = form.querySelector('[name="checkOutDate"]');
  inEl.addEventListener("change", () => {
    outEl.min = plusDays(inEl.value, 1);
    if (outEl.value <= inEl.value) outEl.value = plusDays(inEl.value, 1);
  });
}
