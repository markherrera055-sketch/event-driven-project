import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, date, dateTime, badge, errorHTML, emptyHTML, openModal, toast, toastError, session } from "../core/ui.js";

const root = $("#page-root");
let g;

function render() {
  $(".page-head h1").textContent = g.fullName;
  $(".page-head p").textContent = `Guest since ${dateTime(g.createdAt)}`;
  setHTML($("#page-actions"), session.isReceptionist ? html`<button class="btn" id="edit">Edit contact details</button>` : "");
  setHTML(
    root,
    html`<div class="grid grid-main">
      <div class="card"><div class="card-head"><h2>Stay history</h2><span class="muted">${g.reservations.length} reservation(s)</span></div>
        <div class="card-body flush">${
          g.reservations.length
            ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Code</th><th>Dates</th><th>Room</th><th>Status</th></tr></thead><tbody>
              ${g.reservations.map((r) => html`<tr class="clickable" data-href="${r.stay ? `/front-desk/stays/${r.stay.id}` : `/front-desk/reservations/${r.id}`}">
                <td class="mono strong">${r.reservationCode}</td><td>${date(r.checkInDate)} → ${date(r.checkOutDate)}</td>
                <td>${r.room ? r.room.roomNumber : "—"} <span class="sub">${r.roomType}</span></td><td>${badge(r.status)}</td></tr>`)}
              </tbody></table></div>`
            : emptyHTML("No reservations")
        }</div></div>
      <div class="card"><div class="card-head"><h2>Contact</h2></div><div class="card-body"><dl class="dl">
        <dt>First name</dt><dd>${g.firstName}</dd><dt>Last name</dt><dd>${g.lastName}</dd>
        <dt>Email</dt><dd>${g.email || "—"}</dd><dt>Phone</dt><dd>${g.phone || "—"}</dd>
        <dt>Updated</dt><dd>${dateTime(g.updatedAt)}</dd></dl></div></div>
    </div>`
  );
}

async function load() {
  try {
    g = await api.get(`/guests/${session.entityId}`);
    render();
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#edit")) {
    try {
      const updated = await openModal({
        title: "Edit contact details",
        body: html`<div class="field-row"><div class="field"><label>First name</label><input name="firstName" value="${g.firstName}" required maxlength="80"></div>
          <div class="field"><label>Last name</label><input name="lastName" value="${g.lastName}" required maxlength="80"></div></div>
          <div class="field"><label>Email</label><input name="email" type="email" value="${g.email || ""}" maxlength="150"></div>
          <div class="field"><label>Phone</label><input name="phone" value="${g.phone || ""}" maxlength="20"></div>`,
        onSubmit: (v) => api.patch(`/guests/${g.id}`, { firstName: v.firstName, lastName: v.lastName, email: v.email ?? "", phone: v.phone ?? "" }),
      });
      if (updated) {
        toast("Guest updated.", "success");
        load();
      }
    } catch (err) {
      toastError(err);
    }
    return;
  }
  const row = e.target.closest("tr[data-href]");
  if (row) window.location.href = row.dataset.href;
});
load();
