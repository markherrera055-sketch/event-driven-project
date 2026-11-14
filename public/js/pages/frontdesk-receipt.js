import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, money, date, dateTime, label, errorHTML, session } from "../core/ui.js";

const root = $("#page-root");

async function load() {
  try {
    const [r, me] = await Promise.all([api.get(`/receipts/${session.entityId}`), api.get("/me")]);
    const b = r.bill;
    $(".page-head h1").textContent = `Official receipt ${r.receiptNo}`;
    $(".page-head p").textContent = `${r.guest.fullName} · Room ${r.room.roomNumber}`;
    const back = document.querySelector(".breadcrumb");
    if (back) back.innerHTML = String(html`<a href="/front-desk/stays/${r.stay.id}">Guest folio</a> /`);
    setHTML(
      root,
      html`<div class="card"><div class="card-body receipt">
        <div class="receipt-head">
          <div><h2>${me.hotel.name}</h2><div class="muted">Official receipt</div></div>
          <div class="right"><div class="strong mono">${r.receiptNo}</div><div class="muted">${dateTime(r.issuedAt)}</div></div>
        </div>
        <dl class="dl">
          <dt>Guest</dt><dd>${r.guest.fullName}</dd>
          <dt>Reservation</dt><dd class="mono">${r.reservationCode}</dd>
          <dt>Room</dt><dd>${r.room.roomNumber} · ${r.room.roomType}</dd>
          <dt>Stay</dt><dd>${dateTime(r.stay.checkInAt)} → ${r.stay.checkOutAt ? dateTime(r.stay.checkOutAt) : "in-house"}</dd>
        </dl>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Description</th><th class="right">Amount</th></tr></thead>
          <tbody>
            <tr><td>Room charge — ${b.nights} night${b.nights === 1 ? "" : "s"} × ${money(b.nightlyRate)}</td><td class="num">${money(b.roomCharge)}</td></tr>
            ${b.charges.map((c) => html`<tr><td>${c.description} (${label(c.category)}, ${date(c.transactionAt)})</td><td class="num">${money(c.amount)}</td></tr>`)}
            ${b.adjustments.map((a) => html`<tr><td>Adjustment: ${a.reason}</td><td class="num">${money(a.amount)}</td></tr>`)}
          </tbody>
          <tfoot><tr><td>Total paid</td><td class="num receipt-total">${money(b.totals.totalDue)}</td></tr></tfoot>
        </table></div>
        <dl class="dl">
          <dt>Payment method</dt><dd>${label(r.payment.method)}${r.payment.gatewayReference ? ` · ref ${r.payment.gatewayReference}` : ""}</dd>
          <dt>Received by</dt><dd>${r.receivedBy?.fullName}</dd>
        </dl>
        <p class="muted small">Thank you for staying with us.</p>
      </div></div>`
    );
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

$("#print")?.addEventListener("click", () => window.print());
load();
