/**
 * Admin Console — integration monitoring for the connected hotel systems
 * (Guest Booking, Restaurant POS, Housekeeping, HR/Payroll).
 * Shows configuration status (never the keys), the outbound webhook log with
 * a manual retry, and the inbound request log.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, dateTime, badge, errorHTML, emptyHTML, withBusy, toast, toastError, openModal, confirmDialog } from "../core/ui.js";

const root = $("#page-root");

const yesNo = (v, yes = "Configured", no = "Not configured") => (v ? html`<span class="badge badge-green">${yes}</span>` : html`<span class="badge">${no}</span>`);

const clientCard = (c, status) => html`<div class="card"><div class="card-head"><h2>${c.label} <span class="muted small">· Member ${c.member}</span></h2>${yesNo(c.enabled, "Enabled", "Disabled")}</div>
  <div class="card-body"><dl class="dl">
    <dt>Base URL</dt><dd class="mono">${c.basePath}</dd>
    <dt>API key</dt><dd>${yesNo(c.enabled)}</dd>
    <dt>Permissions</dt><dd class="mono small">${c.scopes.join(", ")}</dd>
    <dt>Signed requests in</dt><dd>${yesNo(c.inboundSigned, "Required (HMAC)", "Not required")}</dd>
    <dt>Webhooks out</dt><dd>${c.webhookConfigured ? html`${yesNo(true)} ${yesNo(c.webhookSigned, "HMAC-SHA256", "Unsigned")}` : yesNo(false)}</dd>
    <dt>Events</dt><dd class="small">${c.webhookEvents.length ? c.webhookEvents.join(", ") : html`<span class="muted">none (reads from the PMS)</span>`}</dd>
    <dt>Rate limit</dt><dd>${status.rateLimitPerMinute} requests / minute</dd></dl></div></div>`;

/** StayBook online booking: which StayBook room id each Frontdesk room is sold as. */
const staybookCard = (status, mapping) => html`<div class="card"><div class="card-head"><h2>StayBook room mapping <span class="muted small">· online booking</span></h2>
  <span class="muted small">StayBook hotel id: ${mapping.hotelId ? html`<span class="mono">${mapping.hotelId}</span>` : "any (STAYBOOK_HOTEL_ID not set)"}</span></div>
  <div class="card-body"><p class="muted small">StayBook calls <code>${status.staybook.basePath}</code> with the Booking API key. Each StayBook room id must be mapped to exactly one Frontdesk room; bookings for unmapped rooms are refused (<code>ROOM_NOT_MAPPED</code>). Changing a mapping does not move existing reservations.</p></div>
  <div class="card-body flush"><div class="table-wrap"><table class="table"><thead><tr><th>Room</th><th>Type</th><th>In service</th><th>StayBook room id</th><th></th></tr></thead><tbody>
  ${mapping.rooms.map((r) => html`<tr><td class="mono">${r.roomNumber}</td><td>${r.roomType}</td><td>${r.isActive ? "Yes" : html`<span class="muted">No</span>`}</td>
    <td class="mono">${r.staybookRoomId ?? html`<span class="muted">not mapped</span>`}</td>
    <td class="right nowrap"><button class="btn btn-sm" data-map-room="${r.roomId}" data-room-number="${r.roomNumber}" data-current="${r.staybookRoomId ?? ""}">${r.staybookRoomId ? "Change" : "Map"}</button>
      ${r.staybookRoomId ? html` <button class="btn btn-sm btn-secondary" data-unmap="${r.staybookRoomId}" data-room-number="${r.roomNumber}">Remove</button>` : ""}</td></tr>`)}
  </tbody></table></div></div></div>`;

/** StayBook synchronisation problems: refused StayBook requests and webhooks to StayBook that failed for good. */
const staybookIssuesCard = (issues) => html`<div class="card"><div class="card-head"><h2>StayBook sync issues</h2>
  <span class="muted small"><a href="/front-desk/online-reservations">Online reservations →</a></span></div>
  <div class="card-body"><p class="muted small">Front-desk staff are notified of each of these (Room conflict warning / Synchronization failed). Refused requests changed nothing in the Frontdesk; StayBook shows them as <code>REJECTED</code> and retries after the cause is fixed.</p></div>
  <div class="card-body flush">${
    issues.failedWebhooks.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Booking</th><th>Event</th><th>Attempts</th><th>Last error</th><th>Failed</th><th></th></tr></thead><tbody>
        ${issues.failedWebhooks.map((w) => html`<tr><td>${w.id}</td><td class="mono"><a href="/front-desk/online-reservations?open=${w.reservationId}">${w.bookingReference}</a></td><td class="mono">${w.event}</td><td class="num">${w.attempts}</td>
          <td class="small">${w.lastError || ""}</td><td class="nowrap">${dateTime(w.updatedAt)}</td><td class="right"><button class="btn btn-sm" data-retry="${w.id}">Re-send</button></td></tr>`)}
        </tbody></table></div>`
      : html`<div class="card-body muted small">No failed webhooks to StayBook.</div>`
  }</div>
  <div class="card-body flush">${
    issues.refusedRequests.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Request</th><th>Status</th><th>Code</th><th>Message</th></tr></thead><tbody>
        ${issues.refusedRequests.map((q) => html`<tr><td class="nowrap">${dateTime(q.createdAt)}</td><td class="mono small">${q.method} ${q.path.replace("/api/v1/integrations/staybook", "")}</td>
          <td><span class="badge badge-red plain">${q.status}</span></td><td class="mono small">${q.code || ""}</td><td class="small">${q.message || ""}</td></tr>`)}
        </tbody></table></div>${issues.refusedTotal > issues.refusedRequests.length ? html`<div class="pager"><span>Latest ${issues.refusedRequests.length} of ${issues.refusedTotal} refused requests</span></div>` : ""}`
      : html`<div class="card-body muted small">No refused StayBook requests.</div>`
  }</div></div>`;

/** Restaurant POS purchase notifications (front-desk review queue). Configuration lives in .env. */
const posOrdersCard = (p, sum) => html`<div class="card"><div class="card-head"><h2>Restaurant POS purchases <span class="muted small">· front-desk review</span></h2>${yesNo(p.enabled, "Enabled", "Disabled")}</div>
  <div class="card-body">
    ${p.enabled && !p.signed ? html`<div class="alert alert-warning">POS requests are authenticated by API key only. Set <code>POS_INBOUND_SECRET</code> (and share it with the POS developer) so every purchase notification is HMAC-signed and replay-protected before go-live.</div>` : ""}
    <dl class="dl">
      <dt>Endpoint</dt><dd class="mono">POST ${p.endpoint}</dd>
      <dt>Signed requests</dt><dd>${yesNo(p.signed, "Required (HMAC)", "Not required")}</dd>
      <dt>Accepted restaurants</dt><dd>${p.restaurantIds.length ? html`<span class="mono">${p.restaurantIds.join(", ")}</span>` : html`<span class="muted">any id (POS_RESTAURANT_IDS not set)</span>`}</dd>
      <dt>Default restaurant id</dt><dd class="mono">${p.defaultRestaurantId}</dd>
      <dt>Awaiting review</dt><dd>${sum ? html`${sum.open} <a class="small" href="/front-desk/restaurant-charges">Open queue →</a>` : "—"}</dd>
      <dt>Voided after billing</dt><dd>${sum ? sum.needsAdjustment : "—"}</dd>
      <dt>Legacy direct posting</dt><dd class="small"><span class="mono">POST /pos/room-charges</span> is deprecated but still accepted (no staff review). An order is never billed twice across both paths.</dd>
    </dl></div></div>`;

async function load() {
  try {
    const [{ status, outbox, requests }, mapping, posSummary, staybookIssues] = await Promise.all([
      api.get("/admin/integrations"),
      api.get("/admin/staybook/room-mappings"),
      api.get("/pos-orders/summary").catch(() => null),
      api.get("/admin/staybook/sync-issues").catch(() => null),
    ]);
    setHTML(
      root,
      html`<div class="alert alert-info">The Guest Booking System, Restaurant POS, Housekeeping System and HR/Payroll are separate applications. They connect to this PMS through authenticated endpoints under <code>/api/v1/integrations</code>. Keys, secrets and webhook URLs are configured in the server's <code>.env</code> file (see docs/INTEGRATIONS.md).${status.requireHttps ? "" : " HTTPS is not enforced on this server (development)."}</div>
      <div class="grid grid-2">${status.clients.map((c) => clientCard(c, status))}</div>
      ${posOrdersCard(status.posOrders, posSummary)}
      ${staybookCard(status, mapping)}
      ${staybookIssues ? staybookIssuesCard(staybookIssues) : ""}
      <div class="card"><div class="card-head"><h2>Outbound webhooks</h2><span class="muted small">latest 50</span></div><div class="card-body flush">${
        outbox.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Event id</th><th>Target</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Created</th><th></th></tr></thead><tbody>
            ${outbox.map((o) => html`<tr><td>${o.id}</td><td class="mono small">${o.eventId || ""}</td><td>${badge(o.target)}</td><td class="mono">${o.eventType}</td><td>${badge(o.status)}</td><td class="num">${o.attempts}</td>
              <td class="small">${o.lastError || ""}</td><td class="nowrap">${dateTime(o.createdAt)}</td>
              <td class="right">${o.status === "FAILED" || o.status === "SKIPPED" ? html`<button class="btn btn-sm" data-retry="${o.id}">Retry</button>` : ""}</td></tr>`)}
            </tbody></table></div>`
          : emptyHTML("No webhook events yet")
      }</div></div>
      <div class="card"><div class="card-head"><h2>Inbound requests</h2><span class="muted small">latest 50</span></div><div class="card-body flush">${
        requests.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Source</th><th>Request</th><th>Idempotency key</th><th>Status</th></tr></thead><tbody>
            ${requests.map((q) => html`<tr><td class="nowrap">${dateTime(q.createdAt)}</td><td>${badge(q.source)}</td><td class="mono">${q.method} ${q.path}</td><td class="mono small">${q.idempotencyKey}</td>
              <td>${q.responseStatus === null ? html`<span class="badge badge-amber">Processing</span>` : html`<span class="badge ${q.responseStatus < 300 ? "badge-green" : "badge-red"} plain">${q.responseStatus}</span>`}</td></tr>`)}
            </tbody></table></div>`
          : emptyHTML("No inbound integration requests yet")
      }</div></div>`
    );
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

async function mapRoom(btn) {
  const { mapRoom: roomId, roomNumber, current } = btn.dataset;
  const saved = await openModal({
    title: `StayBook id for room ${roomNumber}`,
    body: html`<div class="field"><label>StayBook room id</label><input name="staybookRoomId" value="${current}" required maxlength="50" pattern="[A-Za-z0-9._:\\-]+" title="The room's id in StayBook (e.g. 1)"></div>
      <p class="muted small">Use the <code>id</code> StayBook returns for this room in <code>GET /rooms/search</code>.</p>`,
    onSubmit: ({ staybookRoomId }) =>
      api.put(`/admin/staybook/room-mappings/${encodeURIComponent(staybookRoomId)}`, { roomId: Number(roomId), replace: !!current }),
  });
  if (saved) {
    toast(`Room ${roomNumber} is sold as StayBook room ${saved.staybookRoomId}.`, "success");
    load();
  }
}

async function unmapRoom(btn) {
  const { unmap, roomNumber } = btn.dataset;
  if (!(await confirmDialog(`Stop accepting StayBook bookings for room ${roomNumber} (StayBook room ${unmap})? Existing reservations are kept.`, { confirmLabel: "Remove mapping", danger: true }))) return;
  try {
    await api.delete(`/admin/staybook/room-mappings/${encodeURIComponent(unmap)}`);
    toast("Mapping removed.", "success");
    load();
  } catch (err) {
    toastError(err);
  }
}

root.addEventListener("click", async (e) => {
  const mapBtn = e.target.closest("[data-map-room]");
  if (mapBtn) return mapRoom(mapBtn);
  const unmapBtn = e.target.closest("[data-unmap]");
  if (unmapBtn) return unmapRoom(unmapBtn);
  const btn = e.target.closest("[data-retry]");
  if (!btn) return;
  try {
    await withBusy(btn, () => api.post(`/admin/integrations/outbox/${btn.dataset.retry}/retry`));
    toast("Event re-queued for delivery.", "success");
    load();
  } catch (err) {
    toastError(err);
  }
});
load();
