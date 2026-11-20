/**
 * Restaurant charges — purchases notified by the external Restaurant POS.
 * Staff open a purchase, check who it is for, and (receptionists) add it to
 * the verified guest's folio as an outstanding charge or reject it.
 * Nothing here records a payment: the guest pays the combined bill at checkout.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import {
  $, html, raw, setHTML, dateTime, money, badge, label, errorHTML, emptyHTML, loadingHTML, debounce,
  openModal, toast, toastError, session, queryParam, setQueryParam, pagerHTML,
} from "../core/ui.js";

const root = $("#page-root");

const TABS = [
  { status: "OPEN", text: "Awaiting review", count: (s) => s.open },
  { status: "NEEDS_GUEST_VERIFICATION", text: "Needs guest verification", count: (s) => s.needsVerification },
  { status: "ADDED_TO_FOLIO", text: "Added to folio" },
  { status: "ALREADY_PAID", text: "Paid at restaurant" },
  { status: "REJECTED", text: "Rejected" },
  { status: "", text: "All" },
];

const STATUS_TEXT = {
  PENDING_REVIEW: "Awaiting review",
  NEEDS_GUEST_VERIFICATION: "Needs guest verification",
  ADDED_TO_FOLIO: "Added to folio",
  REJECTED: "Rejected",
  ALREADY_PAID: "Paid at restaurant",
};
const statusBadge = (o) => badge(o.status, STATUS_TEXT[o.status]);

const ISSUE_TEXT = {
  NO_RESERVATION_REFERENCE: "The POS did not send a reservation id or code.",
  RESERVATION_NOT_FOUND: "The reservation the POS sent does not exist.",
  RESERVATION_REFERENCE_MISMATCH: "The reservation id and code sent by the POS belong to different reservations.",
  GUEST_ID_MISMATCH: "The guest id does not belong to that reservation.",
  NOT_IN_HOUSE: "That reservation is not checked in.",
  ROOM_MISMATCH: "The room number is not the reservation's current room.",
  NAME_MISMATCH: "The customer name does not match the registered guest.",
  ORDERED_BEFORE_CHECK_IN: "The order time is before the guest checked in.",
  FOLIO_CLOSED: "The guest's bill is already confirmed, so the purchase cannot be added. It must be settled at the restaurant.",
};
const REASON_TEXT = { RESERVATION: "Reservation", ROOM: "Room", NAME: "Name" };

const state = {
  status: queryParam("status") ?? "OPEN",
  needsAdjustment: queryParam("needsAdjustment") === "true" ? true : undefined,
  search: "",
  page: 1,
};
let summary = null;

const itemsSummary = (items) => {
  const text = items.map((i) => `${i.quantity}× ${i.name}`).join(", ");
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
};

function frame() {
  setHTML(
    root,
    html`<div id="attention"></div>
    <div class="card">
      <div class="tabs" role="tablist">${TABS.map((t) => html`<button class="tab" role="tab" data-status="${t.status}">${t.text}<span class="count hidden" data-tab-count="${t.status}"></span></button>`)}</div>
      <div class="toolbar"><input type="search" id="search" placeholder="POS order id, customer, room or reservation code…" aria-label="Search restaurant purchases"></div>
      <div id="results"></div>
    </div>`
  );
  $("#search").addEventListener("input", debounce((e) => {
    state.search = e.target.value.trim();
    state.page = 1;
    load();
  }));
}

function renderSummary() {
  if (!summary) return;
  for (const t of TABS) {
    const el = root.querySelector(`[data-tab-count="${t.status}"]`);
    if (!el || !t.count) continue;
    const n = t.count(summary);
    el.textContent = n;
    el.classList.toggle("hidden", !n);
  }
  setHTML(
    $("#attention"),
    summary.needsAdjustment
      ? html`<div class="alert alert-danger"><span><strong>${summary.needsAdjustment} purchase${summary.needsAdjustment === 1 ? " was" : "s were"} voided by the restaurant after being added to a folio.</strong>
          The folio charge is never removed automatically: correct the guest's bill with an adjustment, then mark the void as handled.
          <a href="#" data-filter-adjustment>Show ${summary.needsAdjustment === 1 ? "it" : "them"}</a></span></div>`
      : ""
  );
}

async function load() {
  root.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.status === state.status));
  const results = $("#results");
  setHTML(results, loadingHTML());
  try {
    const { data, meta } = await api.list("/pos-orders", {
      status: state.status,
      search: state.search,
      needsAdjustment: state.needsAdjustment,
      page: state.page,
    });
    if (!data.length) {
      const open = state.status === "OPEN";
      return setHTML(results, emptyHTML(open ? "Nothing to review" : "No purchases", open ? "New purchases from the restaurant POS will appear here." : ""));
    }
    setHTML(
      results,
      html`${state.needsAdjustment ? html`<div class="card-body"><div class="alert alert-info">Showing purchases voided after billing only. <a href="#" data-clear-adjustment>Show all</a></div></div>` : ""}
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Received</th><th>POS order</th><th>Customer / reservation</th><th>Room</th><th>Items</th><th class="right">Total</th><th>Status</th></tr></thead>
        <tbody>${data.map(
          (o) => html`<tr class="clickable" data-order="${o.id}">
            <td class="nowrap">${dateTime(o.receivedAt)}</td>
            <td class="mono">${o.externalOrderId}<div class="sub">${o.orderRef} · ${o.outletName || o.restaurantId}</div></td>
            <td>${o.customerName || html`<span class="muted">No name sent</span>`}
              <div class="sub">${o.reservation ? html`${o.reservation.reservationCode} · ${o.reservation.guestName}` : o.reservationReference ? `Sent: ${o.reservationReference}` : "No reservation sent"}</div></td>
            <td>${o.roomNumber || "—"}${o.reservation?.roomNumber && o.reservation.roomNumber !== o.roomNumber ? html`<div class="sub">Reservation: ${o.reservation.roomNumber}</div>` : ""}</td>
            <td class="small">${itemsSummary(o.items)}</td>
            <td class="num">${money(o.total)}</td>
            <td>${statusBadge(o)}${o.needsAdjustment ? html`<div><span class="badge badge-red plain">Voided after billing</span></div>` : o.voidedAt ? html`<div class="sub">Voided by POS</div>` : ""}</td>
          </tr>`
        )}</tbody></table></div>${pagerHTML(meta)}`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

// ── Detail / review ──────────────────────────────────────────────────────────

const itemsTable = (o) => html`<div class="table-wrap"><table class="table">
  <thead><tr><th>Item</th><th class="right">Qty</th><th class="right">Unit price</th><th class="right">Amount</th></tr></thead>
  <tbody>${o.items.map((i) => html`<tr><td>${i.name}${i.description ? html`<div class="sub">${i.description}</div>` : ""}${i.sku ? html`<div class="sub mono">${i.sku}</div>` : ""}</td>
    <td class="num">${i.quantity}</td><td class="num">${money(i.unitPrice)}</td><td class="num">${money(i.lineTotal ?? i.unitPrice * i.quantity)}</td></tr>`)}</tbody>
  </table></div>
  <dl class="order-totals">
    <dt>Subtotal</dt><dd>${money(o.subtotal)}</dd>
    ${o.serviceCharge ? html`<dt>Service charge</dt><dd>${money(o.serviceCharge)}</dd>` : ""}
    ${o.tax ? html`<dt>Tax</dt><dd>${money(o.tax)}</dd>` : ""}
    ${o.discount ? html`<dt>Discount</dt><dd>−${money(o.discount)}</dd>` : ""}
    <dt class="grand">Total</dt><dd class="grand">${money(o.total)}</dd>
  </dl>`;

function stayOptions(o, inHouse) {
  const byId = new Map(o.candidates.map((c) => [c.stayId, c]));
  const others = inHouse.filter((s) => !byId.has(s.id)).map((s) => ({
    stayId: s.id,
    reservationCode: s.reservation.reservationCode,
    roomNumber: s.reservation.room.roomNumber,
    guestName: s.reservation.guest.fullName,
    folioOpen: !s.bill || s.bill.status === "DRAFT",
    reasons: [],
  }));
  const options = [...o.candidates, ...others];
  if (!options.length) return html`<div class="alert alert-warning">No guest is checked in. The purchase cannot be added to a folio; reject it so the restaurant collects payment.</div>`;
  return html`<div class="pick-list" role="radiogroup" aria-label="Guest stay">${options.map(
    (c) => html`<label class="pick-option">
      <input type="radio" name="stayId" value="${c.stayId}" ${c.suggested ? raw("checked") : ""} ${c.folioOpen ? "" : raw("disabled")} required>
      <span><strong>Room ${c.roomNumber}</strong> · ${c.guestName}<div class="sub">${c.reservationCode}${c.folioOpen ? "" : " · bill already confirmed"}</div></span>
      <span class="row">${c.suggested ? html`<span class="badge badge-green">Suggested</span>` : ""}${c.reasons.filter((r) => !c.suggested).map((r) => html`<span class="badge plain">${REASON_TEXT[r]} matches</span>`)}</span>
    </label>`
  )}</div>`;
}

function detailBody(o, inHouse) {
  const open = o.status === "PENDING_REVIEW" || o.status === "NEEDS_GUEST_VERIFICATION";
  const canDecide = session.isReceptionist;
  return html`
    <div class="row between"><span>${statusBadge(o)} <span class="muted small">${o.orderRef}</span></span><span class="muted small">Received ${dateTime(o.receivedAt)}${o.deliveryCount > 1 ? ` · delivered ${o.deliveryCount}×` : ""}</span></div>
    ${o.processingError ? html`<div class="alert alert-warning">${o.processingError}</div>` : ""}
    ${o.needsAdjustment ? html`<div class="alert alert-danger">The restaurant voided this order after it was added to the folio. Correct the guest's bill with an adjustment (or refund if it was already paid), then mark the void as handled.</div>` : ""}
    <div class="grid grid-2">
      <dl class="dl small">
        <dt>POS order</dt><dd class="mono">${o.externalOrderId}</dd>
        <dt>Restaurant</dt><dd>${o.outletName || o.restaurantId}${o.outletName ? html` <span class="muted mono">(${o.restaurantId})</span>` : ""}</dd>
        <dt>Ordered</dt><dd>${dateTime(o.orderedAt)}</dd>
        <dt>POS payment</dt><dd>${label(o.posPaymentStatus)}${o.voidedAt ? html` · <span class="badge badge-red plain">Voided ${dateTime(o.voidedAt)}</span>` : ""}</dd>
      </dl>
      <dl class="dl small">
        <dt>Customer (POS)</dt><dd>${o.customerName || html`<span class="muted">not sent</span>`}</dd>
        <dt>Reservation (POS)</dt><dd>${o.reservationReference || html`<span class="muted">not sent</span>`}</dd>
        <dt>Room (POS)</dt><dd>${o.roomNumber || html`<span class="muted">not sent</span>`}</dd>
        ${o.reservation ? html`<dt>PMS reservation</dt><dd><a href="/front-desk/reservations/${o.reservation.id}">${o.reservation.reservationCode}</a> · ${o.reservation.guestName}${o.reservation.roomNumber ? ` · Room ${o.reservation.roomNumber}` : ""}</dd>` : ""}
      </dl>
    </div>
    ${o.matchIssues.length && open ? html`<div class="alert alert-warning"><span><strong>Verify the guest before adding this purchase.</strong><ul class="notes">${o.matchIssues.map((i) => html`<li>${ISSUE_TEXT[i] || label(i)}</li>`)}</ul></span></div>` : ""}
    <h3 class="small muted">Items</h3>
    ${itemsTable(o)}
    ${o.status === "ALREADY_PAID" ? html`<div class="alert alert-info">Paid at the restaurant. This purchase is not billed to the room and needs no action.</div>` : ""}
    ${o.status === "ADDED_TO_FOLIO" ? html`<div class="alert alert-success"><span>Added to the folio${o.reviewedBy ? ` by ${o.reviewedBy.fullName}` : ""}${o.reviewedAt ? ` on ${dateTime(o.reviewedAt)}` : ""} as an outstanding charge. ${o.stayId ? html`<a href="/front-desk/stays/${o.stayId}">Open folio</a>` : ""}${o.reviewNote ? html`<div class="small">Verification note: ${o.reviewNote}</div>` : ""}${o.adjustmentResolvedAt ? html`<div class="small">Void handled by ${o.adjustmentResolvedBy?.fullName || "staff"} on ${dateTime(o.adjustmentResolvedAt)}.</div>` : ""}</span></div>` : ""}
    ${o.status === "REJECTED" ? html`<div class="alert alert-info">Rejected${o.reviewedBy ? ` by ${o.reviewedBy.fullName}` : ""}${o.reviewedAt ? ` on ${dateTime(o.reviewedAt)}` : ""}: ${o.rejectionReason}</div>` : ""}
    ${open && !canDecide ? html`<div class="alert alert-info">Only receptionists can add restaurant purchases to a folio or reject them.</div>` : ""}
    ${open && canDecide ? html`<hr>
      <div class="field"><label>Add to the folio of</label>${stayOptions(o, inHouse)}
        <div class="hint">Confirm the guest with the restaurant or the guest before approving. The charge is billed at checkout; nothing is recorded as paid.</div></div>
      <div class="field"><label for="review-note">Verification note ${o.status === "NEEDS_GUEST_VERIFICATION" ? "(required)" : "(required if you choose a stay other than the suggested one)"}</label>
        <textarea id="review-note" name="note" maxlength="255" ${o.status === "NEEDS_GUEST_VERIFICATION" ? raw("required minlength=\"3\"") : ""} placeholder="e.g. Confirmed with the guest by phone; signed chit shows room 204"></textarea></div>
      <div class="row"><button type="button" class="btn btn-ghost-danger" data-close data-secondary="reject">Reject purchase…</button></div>` : ""}
    ${o.needsAdjustment && canDecide ? html`<div class="row"><button type="button" class="btn" data-close data-secondary="resolve-void">Mark void as handled</button></div>` : ""}`;
}

async function openOrder(id) {
  let o;
  let inHouse = [];
  try {
    o = await api.get(`/pos-orders/${id}`);
    const open = o.status === "PENDING_REVIEW" || o.status === "NEEDS_GUEST_VERIFICATION";
    if (open && session.isReceptionist) inHouse = await api.get("/stays", { status: "IN_HOUSE" });
  } catch (err) {
    return toastError(err);
  }
  const open = o.status === "PENDING_REVIEW" || o.status === "NEEDS_GUEST_VERIFICATION";
  let secondary = null;
  const result = await openModal({
    title: `Restaurant purchase — ${money(o.total)}`,
    wide: true,
    cancelLabel: "Close",
    submitLabel: `Add ${money(o.total)} to folio`,
    body: detailBody(o, inHouse),
    onOpen: (form) => form.querySelectorAll("[data-secondary]").forEach((b) => b.addEventListener("click", () => (secondary = b.dataset.secondary))),
    onSubmit: open && session.isReceptionist && (o.candidates.length || inHouse.length)
      ? (v) => api.post(`/pos-orders/${o.id}/approve`, { stayId: Number(v.stayId), note: v.note || undefined })
      : undefined,
  });
  if (result && result !== true) {
    toast(`Added to the folio of room ${result.reservation?.roomNumber ?? ""}. It will be billed at checkout.`, "success");
    return refresh();
  }
  if (secondary === "reject") return rejectOrder(o);
  if (secondary === "resolve-void") return resolveVoid(o);
  return undefined;
}

async function rejectOrder(o) {
  const done = await openModal({
    title: `Reject purchase ${o.externalOrderId}`,
    submitLabel: "Reject purchase",
    danger: true,
    body: html`<p>The purchase will not be billed to any room. The restaurant is notified and must collect payment directly.</p>
      <div class="field"><label for="reject-reason">Reason</label><input id="reject-reason" name="reason" required minlength="3" maxlength="255" placeholder="e.g. Guest is not staying at the hotel"></div>`,
    onSubmit: (v) => api.post(`/pos-orders/${o.id}/reject`, { reason: v.reason }),
  });
  if (done) {
    toast("Purchase rejected. The restaurant has been notified.", "success");
    refresh();
  }
}

async function resolveVoid(o) {
  const done = await openModal({
    title: "Void handled?",
    submitLabel: "Mark as handled",
    body: html`<p>Confirm that the guest's bill was corrected for voided order <span class="mono">${o.externalOrderId}</span> (${money(o.total)}), for example with a bill adjustment.</p>`,
    onSubmit: () => api.post(`/pos-orders/${o.id}/resolve-void`),
  });
  if (done) {
    toast("Void marked as handled.", "success");
    refresh();
  }
}

function refresh() {
  load();
  import("../core/notifications.js").then((m) => m.refreshNotifications());
}

// ── Events ───────────────────────────────────────────────────────────────────

frame();
root.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) {
    state.status = tab.dataset.status;
    state.needsAdjustment = undefined;
    state.page = 1;
    setQueryParam("status", state.status === "OPEN" ? "" : state.status || "ALL");
    setQueryParam("needsAdjustment", "");
    return load();
  }
  if (e.target.closest("[data-filter-adjustment]")) {
    e.preventDefault();
    Object.assign(state, { status: "ADDED_TO_FOLIO", needsAdjustment: true, page: 1 });
    setQueryParam("status", "ADDED_TO_FOLIO");
    setQueryParam("needsAdjustment", "true");
    return load();
  }
  if (e.target.closest("[data-clear-adjustment]")) {
    e.preventDefault();
    state.needsAdjustment = undefined;
    setQueryParam("needsAdjustment", "");
    return load();
  }
  const pageBtn = e.target.closest("[data-goto-page]");
  if (pageBtn) {
    state.page = Number(pageBtn.dataset.gotoPage);
    return load();
  }
  const row = e.target.closest("tr[data-order]");
  if (row) return openOrder(Number(row.dataset.order));
  return undefined;
});

let lastOpenId;
document.addEventListener("pos-orders:summary", (e) => {
  summary = e.detail;
  renderSummary();
  // A new purchase arrived while this page is open: refresh the list.
  if (lastOpenId !== undefined && summary.latestOpenId !== lastOpenId && (state.status === "OPEN" || state.status === "NEEDS_GUEST_VERIFICATION" || !state.status)) load();
  lastOpenId = summary.latestOpenId;
});

if (state.status === "ALL") state.status = "";
load();
