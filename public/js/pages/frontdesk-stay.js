/**
 * Guest folio — second half of the lifecycle (Figure 13):
 * Checked-In → Billing (generate / adjust / confirm) → Awaiting Payment
 * (decline → "payment failed" → retry) → Paid (receipt) → Checked-Out.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, raw, setHTML, date, dateTime, money, badge, label, errorHTML, emptyHTML, openModal, confirmDialog, withBusy, toast, toastError, session } from "../core/ui.js";
import { lifecycleStepper } from "../core/lifecycle.js";
import { changeRoom } from "../core/roomPicker.js";

const root = $("#page-root");
const id = session.entityId;
let s;
let gateway = { sandbox: true };

function actionPanel() {
  const bill = s.bill;
  if (s.status === "CHECKED_OUT") {
    const receipt = bill?.payments?.find((p) => p.receipt)?.receipt;
    return html`<div class="alert alert-success">Checked out ${dateTime(s.checkOutAt)} by ${s.checkedOutBy?.fullName}. ${receipt ? html`<a href="/front-desk/receipts/${receipt.id}">View receipt ${receipt.receiptNo}</a>` : ""}</div>`;
  }
  if (!session.isReceptionist) return html`<div class="alert alert-info">Billing, payment and checkout are performed by receptionists.</div>`;
  if (!bill) {
    return html`<div class="action-panel"><h3>Ready for checkout?</h3>
      <p class="muted">Generate the final bill: nights stayed × nightly rate, plus any charges posted to the folio. Room changes are possible until the bill is generated.</p>
      <div class="row"><button class="btn" data-action="change-room">Change room</button>
      <button class="btn btn-primary" data-action="generate">Generate final bill</button></div></div>`;
  }
  if (bill.status === "DRAFT") {
    return html`<div class="action-panel"><h3>Is the bill correct?</h3>
      <p class="muted">Review the bill with the guest. Correct it with an adjustment if needed, then confirm it to take payment.</p>
      <div class="row"><button class="btn" data-action="adjust">Adjust bill</button>
      <button class="btn" data-action="generate">Recalculate</button>
      <button class="btn btn-primary" data-action="confirm">Bill is correct — confirm</button></div></div>`;
  }
  if (bill.status === "CONFIRMED") {
    const failed = bill.payments.filter((p) => p.status === "FAILED");
    return html`<div class="action-panel">
      ${failed.length ? html`<div class="alert alert-danger"><strong>Payment failed</strong> — ${failed.at(-1).failureReason}. Retry with the same or another method.</div>` : ""}
      <h3>Awaiting payment: ${money(bill.totals.totalDue)}</h3>
      <p class="muted">Full payment is required before checkout.</p>
      <button class="btn btn-primary" data-action="pay">${failed.length ? "Retry payment" : "Receive payment"}</button></div>`;
  }
  const receipt = bill.payments.find((p) => p.receipt)?.receipt;
  return html`<div class="action-panel"><h3>Paid — ready to check out</h3>
    <p class="muted">Hand over receipt ${receipt?.receiptNo}, then process the checkout. The room becomes vacant and is sent to housekeeping.</p>
    <div class="row">${receipt ? html`<a class="btn" href="/front-desk/receipts/${receipt.id}">View / print receipt</a>` : ""}
    <button class="btn btn-success" data-action="checkout">Process checkout</button></div></div>`;
}

function billCard() {
  const bill = s.bill;
  const charges = s.charges || [];
  if (!bill) {
    return html`<div class="card"><div class="card-head"><h2>Folio</h2></div><div class="card-body flush">
      ${charges.length ? chargesTable(charges) : emptyHTML("No charges yet", "Restaurant and service charges posted by the POS will appear here.")}</div></div>`;
  }
  const t = bill.totals;
  return html`<div class="card"><div class="card-head"><h2>Final bill</h2>${badge(bill.status, bill.status === "CONFIRMED" ? "Awaiting payment" : undefined)}</div>
    <div class="card-body flush"><div class="table-wrap"><table class="table">
      <thead><tr><th>Description</th><th>Date</th><th class="right">Amount</th></tr></thead>
      <tbody>
        <tr><td>Room ${s.reservation.room.roomNumber} (${s.reservation.room.roomType}) — ${bill.nights} night${bill.nights === 1 ? "" : "s"} × ${money(bill.nightlyRate)}</td><td class="nowrap">${date(s.checkInAt)}</td><td class="num">${money(bill.roomCharge)}</td></tr>
        ${charges.map((c) => html`<tr><td>${c.description} <span class="sub">· ${label(c.category)}${c.outlet ? ` · ${c.outlet}` : ""} · POS ${c.externalTransactionId}</span></td><td class="nowrap">${dateTime(c.transactionAt)}</td><td class="num">${money(c.amount)}</td></tr>`)}
        ${bill.adjustments.map((a) => html`<tr><td>Adjustment: ${a.reason} <span class="sub">· ${a.adjustedBy?.fullName || ""}</span></td><td class="nowrap">${dateTime(a.adjustedAt)}</td><td class="num">${money(a.amount)}</td></tr>`)}
      </tbody>
      <tfoot><tr><td colspan="2">Total due</td><td class="num">${money(t.totalDue)}</td></tr></tfoot>
    </table></div></div></div>`;
}

const chargesTable = (charges) => html`<div class="table-wrap"><table class="table"><thead><tr><th>POS charge</th><th>Date</th><th class="right">Amount</th></tr></thead><tbody>
  ${charges.map((c) => html`<tr><td>${c.description}<div class="sub">${label(c.category)}${c.outlet ? ` · ${c.outlet}` : ""} · ${c.externalTransactionId}</div></td><td>${dateTime(c.transactionAt)}</td><td class="num">${money(c.amount)}</td></tr>`)}
  </tbody></table></div>`;

function paymentsCard() {
  const payments = s.bill?.payments || [];
  if (!payments.length) return "";
  return html`<div class="card"><div class="card-head"><h2>Payment attempts</h2></div><div class="card-body flush"><div class="table-wrap"><table class="table">
    <thead><tr><th>#</th><th>When</th><th>Method</th><th>Status</th><th>Reference</th><th class="right">Amount</th></tr></thead><tbody>
    ${payments.map((p) => html`<tr><td>${p.attemptNo}</td><td class="nowrap">${dateTime(p.processedAt)}</td><td>${label(p.method)}</td>
      <td>${badge(p.status)}${p.failureReason ? html`<div class="sub">${p.failureReason}</div>` : ""}</td>
      <td>${p.receipt ? html`<a href="/front-desk/receipts/${p.receipt.id}">${p.receipt.receiptNo}</a>` : p.gatewayReference || "—"}</td>
      <td class="num">${money(p.amount)}</td></tr>`)}
    </tbody></table></div></div></div>`;
}

function render() {
  const r = s.reservation;
  $(".page-head h1").textContent = `Folio — Room ${r.room.roomNumber}`;
  $(".page-head p").textContent = `${r.guest.fullName} · ${r.reservationCode}`;
  setHTML(
    root,
    html`<div class="card">${lifecycleStepper(r, s, s.bill)}</div>
    <div class="grid grid-main" id="detail-grid">
      <div class="stack">${actionPanel()}${billCard()}${paymentsCard()}</div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Stay</h2>${badge(s.status)}</div><div class="card-body"><dl class="dl">
          <dt>Guest</dt><dd><a href="/guests/${r.guest.id}">${r.guest.fullName}</a></dd>
          <dt>Room</dt><dd>${r.room.roomNumber} · ${r.room.roomType}</dd>
          <dt>Reservation</dt><dd><a href="/front-desk/reservations/${r.id}">${r.reservationCode}</a></dd>
          <dt>Booked dates</dt><dd>${date(r.checkInDate)} → ${date(r.checkOutDate)}</dd>
          <dt>Checked in</dt><dd>${dateTime(s.checkInAt)}<div class="sub">${s.checkedInBy?.fullName || ""}</div></dd>
          ${s.checkOutAt ? html`<dt>Checked out</dt><dd>${dateTime(s.checkOutAt)}<div class="sub">${s.checkedOutBy?.fullName || ""}</div></dd>` : ""}
          ${r.externalPaymentStatus ? html`<dt>Online payment</dt><dd>${label(r.externalPaymentStatus)}</dd>` : ""}
          <dt>Folio charges</dt><dd>${money(s.postedChargesTotal)}</dd>
        </dl></div></div>
      </div></div>`
  );
}

async function load() {
  try {
    s = await api.get(`/stays/${id}`);
    render();
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

async function adjust() {
  const result = await openModal({
    title: "Adjust bill",
    submitLabel: "Add adjustment",
    body: html`<div class="field"><label>Type</label><select name="kind"><option value="-1">Discount / correction (reduces total)</option><option value="1">Additional charge (increases total)</option></select></div>
      <div class="field"><label>Amount (${session.currency})</label><input name="amount" type="number" min="0.01" step="0.01" required></div>
      <div class="field"><label>Reason</label><input name="reason" required minlength="3" maxlength="255" placeholder="e.g. Rate correction"></div>`,
    onSubmit: (v) => api.post(`/bills/${s.bill.id}/adjustments`, { amount: (Number(v.kind) * Number(v.amount)).toFixed(2), reason: v.reason }),
  });
  if (result) {
    toast("Adjustment added.", "success");
    load();
  }
}

async function pay() {
  const total = s.bill.totals.totalDue;
  const tokenField = gateway.sandbox
    ? html`<div class="field" data-for="card"><label>Terminal result (sandbox)</label>
        <select name="paymentToken"><option value="tok_approve_terminal">Approve</option><option value="tok_decline_terminal">Decline</option></select>
        <div class="hint">Sandbox gateway for training/testing. In production the card terminal / e-wallet returns this token.</div></div>`
    : html`<div class="field" data-for="card"><label>Payment token / terminal reference</label><input name="paymentToken" maxlength="200" autocomplete="off"></div>`;
  const payment = await openModal({
    title: `Receive payment — ${money(total)}`,
    submitLabel: `Charge ${money(total)}`,
    body: html`<div class="field"><label>Method</label>
        <div class="row">${["CASH", "CARD", "E_WALLET"].map((m, i) => html`<label class="check"><input type="radio" name="method" value="${m}" ${i === 0 ? raw("checked") : ""}> ${label(m).replace("E wallet", "E-wallet")}</label>`)}</div></div>
      ${tokenField}
      <div class="field" data-for="cash"><label>Cash tendered</label><input name="tendered" type="number" step="0.01" min="${total}" value="${total.toFixed(2)}"><div class="hint" id="change">Change: ${money(0)}</div></div>`,
    onOpen: (form) => {
      const sync = () => {
        const method = form.querySelector('[name="method"]:checked').value;
        form.querySelector('[data-for="card"]').classList.toggle("hidden", method === "CASH");
        form.querySelector('[data-for="cash"]').classList.toggle("hidden", method !== "CASH");
        form.querySelector('[name="tendered"]').disabled = method !== "CASH";
        form.querySelector('[name="paymentToken"]').disabled = method === "CASH";
      };
      form.addEventListener("change", sync);
      form.querySelector('[name="tendered"]').addEventListener("input", (e) => {
        form.querySelector("#change").textContent = `Change: ${money(Math.max(0, Number(e.target.value) - total))}`;
      });
      sync();
    },
    onSubmit: (v) => api.post("/payments", { billId: s.bill.id, method: v.method, amount: total.toFixed(2), paymentToken: v.paymentToken }),
  });
  if (!payment) return;
  if (payment.status === "SUCCESSFUL") toast(`Payment successful. Receipt ${payment.receipt.receiptNo} issued.`, "success");
  else toast(`Payment failed: ${payment.failureReason}`, "error", 8000);
  load();
}

document.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-action]");
  if (!button || !s) return;
  try {
    switch (button.dataset.action) {
      case "generate":
        await withBusy(button, () => api.post("/bills", { stayId: id }));
        toast("Final bill generated.", "success");
        return load();
      case "adjust":
        return await adjust();
      case "change-room": {
        const updated = await changeRoom(s.reservation);
        if (!updated) return undefined;
        toast(`${updated.guest.fullName} moved to room ${updated.room.roomNumber}. The previous room was sent to housekeeping.`, "success");
        return load();
      }
      case "confirm":
        if (!(await confirmDialog(`Confirm the bill of ${money(s.bill.totals.totalDue)}? It cannot be changed after confirmation.`, { confirmLabel: "Confirm bill" }))) return undefined;
        await api.post(`/bills/${s.bill.id}/confirm`);
        toast("Bill confirmed. Ready for payment.", "success");
        return load();
      case "pay":
        return await pay();
      case "checkout":
        if (!(await confirmDialog(`Check out ${s.reservation.guest.fullName} from room ${s.reservation.room.roomNumber}?`, { confirmLabel: "Check out" }))) return undefined;
        await withBusy(button, () => api.post("/checkouts", { stayId: id }));
        toast("Checkout complete. Room is vacant and queued for housekeeping.", "success");
        return load();
      default:
        return undefined;
    }
  } catch (err) {
    toastError(err);
    if (err.status === 409) load();
  }
});

api.get("/me").then((me) => (gateway = me.paymentGateway)).catch(() => {});
load();
