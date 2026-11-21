/**
 * Admin Console — integration monitoring for the connected hotel systems
 * (Guest Booking, Restaurant POS, Housekeeping, HR/Payroll).
 * Shows configuration status (never the keys), the outbound webhook log with
 * a manual retry, and the inbound request log.
 * Room synchronisation: OnlineBooking / RoomCare connection status, room sync
 * jobs (retry, "sync all rooms") and the checkout → RoomCare cleaning
 * notification history (docs/ROOM_SYNC.md).
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, dateTime, badge, label, errorHTML, emptyHTML, withBusy, toast, toastError, openModal, confirmDialog } from "../core/ui.js";

const root = $("#page-root");
let syncFilter = "";

const yesNo = (v, yes = "Configured", no = "Not configured") => (v ? html`<span class="badge badge-green">${yes}</span>` : html`<span class="badge">${no}</span>`);

const clientCard = (c, status) => html`<div class="card"><div class="card-head"><h2>${c.label} <span class="muted small">· Member ${c.member}</span></h2>${yesNo(c.enabled, "Enabled", "Disabled")}</div>
  <div class="card-body"><dl class="dl">
    <dt>Base URL</dt><dd class="mono">${c.basePath}</dd>
    <dt>API key</dt><dd>${yesNo(c.enabled)}</dd>
    <dt>Permissions</dt><dd class="mono small">${c.scopes.join(", ")}</dd>
    <dt>Signed requests in</dt><dd>${
      c.inboundSecretMissing
        ? html`<span class="badge badge-red">Secret missing: writes refused</span> <span class="mono small">${c.source}_INBOUND_SECRET</span>`
        : yesNo(c.inboundSigned, "Required (HMAC)", "Not required")
    }</dd>
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

const CONNECTION_TEXT = { CONNECTED: "Connected", ERROR: "Errors", AWAITING_CONTRACT: "Awaiting API contract", NOT_CONFIGURED: "Not configured", UNKNOWN: "No requests yet" };
const WEBHOOK_LABEL = { STAYBOOK: "Reservation webhooks", ROOMCARE: "Cleaning notifications" };
const connectionBadge = (c) => badge(c, CONNECTION_TEXT[c] || c);

/** One receiving system of the room catalogue (OnlineBooking or RoomCare). */
const syncTargetCard = (t, webhook) => html`<div class="card"><div class="card-head"><h2>${t.label} <span class="muted small">· room sync</span></h2>${connectionBadge(t.connection)}</div>
  <div class="card-body">
    ${t.configured && !t.contractReady ? html`<div class="alert alert-warning">No room data is sent to ${t.label} yet because its room API contract has not been provided. Room changes wait as <b>Blocked</b> jobs and are sent automatically once the adapter is implemented.</div>` : ""}
    <dl class="dl">
      <dt>API URL</dt><dd>${t.configured ? yesNo(true) : html`<span class="badge">Not set</span> <span class="mono small">${t.urlVariable}</span>`}</dd>
      <dt>API contract</dt><dd>${t.contractReady ? yesNo(true, "Implemented") : html`<span class="badge badge-amber">Pending</span>`}</dd>
      <dt>Last successful sync</dt><dd>${dateTime(t.lastSuccessAt)}</dd>
      <dt>Last attempt</dt><dd>${dateTime(t.lastAttemptAt)}</dd>
      ${t.lastError ? html`<dt>Last error</dt><dd class="small">${t.lastError}</dd>` : ""}
      <dt>Rooms mapped</dt><dd>${t.mappedRooms} of ${t.activeRooms}</dd>
      <dt>Jobs</dt><dd class="small">${t.counts.PENDING} pending · ${t.counts.BLOCKED} blocked · ${t.counts.FAILED} failed · ${t.counts.SYNCED} synced</dd>
      ${webhook ? html`<dt>${WEBHOOK_LABEL[t.target]}</dt><dd class="small">${connectionBadge(webhook.connection)} ${webhook.pending} pending · ${webhook.failed} failed · last delivered ${dateTime(webhook.lastSuccessAt)}${webhook.lastError ? html`<br><span class="muted">${webhook.lastError}</span>` : ""}</dd>` : ""}
    </dl>
    ${t.missing.length ? html`<details class="small"><summary>What ${t.label} still has to provide (${t.missing.length})</summary><ul>${t.missing.map((m) => html`<li>${m}</li>`)}</ul></details>` : ""}
  </div>
  <div class="card-body"><button class="btn btn-sm" data-resync="${t.target}" data-label="${t.label}" ${t.configured ? "" : "disabled"} title="${t.configured ? "Queue every room for this system" : `Set ${t.urlVariable} first`}">Sync all rooms</button></div></div>`;

const SYNC_FILTERS = ["", "PENDING", "BLOCKED", "FAILED", "SYNCED", "SUPERSEDED"];
const syncHistoryCard = (jobs) => html`<div class="card"><div class="card-head"><h2>Room synchronisation history</h2>
  <select id="sync-status-filter" class="select-auto" aria-label="Filter by status">${SYNC_FILTERS.map((s) => html`<option value="${s}" ${s === syncFilter ? "selected" : ""}>${s ? label(s) : "All statuses"}</option>`)}</select></div>
  <div class="card-body flush">${
    jobs.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Room</th><th>System</th><th>Operation</th><th>Change</th><th>Status</th><th>Attempts</th><th>External id</th><th>HTTP</th><th>Last error</th><th>Updated</th><th></th></tr></thead><tbody>
        ${jobs.map((j) => html`<tr><td>${j.id}</td><td class="mono">${j.roomNumber}</td><td>${badge(j.target)}</td><td class="mono small">${j.operation}</td><td class="small">${j.trigger}</td>
          <td>${badge(j.status)}</td><td class="num">${j.attempts}</td><td class="mono small">${j.externalRoomId || ""}</td><td>${j.lastResponseStatus ?? ""}</td>
          <td class="small">${j.lastError || ""}</td><td class="nowrap">${dateTime(j.updatedAt)}</td>
          <td class="right">${j.status === "FAILED" || j.status === "BLOCKED" ? html`<button class="btn btn-sm" data-retry-sync="${j.id}">Retry</button>` : ""}</td></tr>`)}
        </tbody></table></div>`
      : emptyHTML(syncFilter ? "No room sync jobs with this status" : "No room sync jobs yet. They appear when a room is created or edited while a system's API URL is configured.")
  }</div></div>`;

const cleaningCard = (data) => html`<div class="card"><div class="card-head"><h2>Cleaning notifications <span class="muted small">· checkout → RoomCare</span></h2>${connectionBadge(data.roomcare.connection)}</div>
  <div class="card-body"><p class="muted small">After each checkout the room becomes <b>Vacant dirty</b> and RoomCare is notified (<code>RoomVacated</code>, retried until delivered). The room is ready for the next guest only after RoomCare reports the cleaning <b>Completed</b> (or the front desk marks it clean).</p>
    <p class="muted small"><b>Unconfirmed assumption:</b> RoomCare is treated as the Housekeeping System (Member 3). These notifications use the Housekeeping webhook settings (<code>HOUSEKEEPING_WEBHOOK_URL</code>) until Member 3 confirms that the two are the same system.</p></div>
  <div class="card-body flush">${
    data.notifications.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Event</th><th>Room</th><th>Reason</th><th>Checked out</th><th>Delivery</th><th>HTTP</th><th>Cleaning</th><th>Room now</th><th></th></tr></thead><tbody>
        ${data.notifications.map((n) => html`<tr><td class="mono small">${n.eventId}</td><td class="mono">${n.roomNumber}${n.roomcareRoomId ? html` <span class="muted small">(RoomCare ${n.roomcareRoomId})</span>` : ""}</td>
          <td class="small">${n.reason || ""} ${n.reservationCode ? html`<span class="mono muted">${n.reservationCode}</span>` : ""}</td><td class="nowrap">${dateTime(n.checkoutTime)}</td>
          <td>${n.delivery ? html`${badge(n.delivery.status)} <span class="muted small">×${n.delivery.attempts}</span>${n.delivery.lastError ? html`<br><span class="small muted">${n.delivery.lastError}</span>` : ""}` : html`<span class="muted small">not sent (no webhook URL)</span>`}</td>
          <td>${n.delivery?.lastResponseStatus ?? ""}</td><td>${badge(n.cleaningStatus)}</td><td>${n.occupancyStatus ? badge(n.occupancyStatus) : ""}</td>
          <td class="right">${n.delivery && (n.delivery.status === "FAILED" || n.delivery.status === "SKIPPED") ? html`<button class="btn btn-sm" data-retry="${n.delivery.id}">Re-send</button>` : ""}</td></tr>`)}
        </tbody></table></div>`
      : emptyHTML("No checkouts yet")
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

/** Loads one section without failing the whole page: resolves to { data } or { error }. */
const section = (promise) => promise.then((data) => ({ data }), (error) => ({ error }));

/** Shown in place of a section whose data could not be loaded (never hidden silently). */
const sectionError = (title, err) => html`<div class="card"><div class="card-head"><h2>${title}</h2><span class="badge badge-red">Not loaded</span></div>
  <div class="card-body">${errorHTML(err)}<p class="muted small">This section could not be loaded, so its status is unknown. The rest of the page is unaffected.</p>
  <button class="btn btn-sm" data-reload>Try again</button></div></div>`;

async function load() {
  try {
    const [{ status, outbox, requests }, mapping, posSummary, staybookIssues, roomSync, cleaning] = await Promise.all([
      api.get("/admin/integrations"),
      api.get("/admin/staybook/room-mappings"),
      api.get("/pos-orders/summary").catch(() => null),
      api.get("/admin/staybook/sync-issues").catch(() => null),
      section(api.get(`/admin/integrations/room-sync${syncFilter ? `?status=${syncFilter}` : ""}`)),
      section(api.get("/admin/integrations/cleaning-notifications")),
    ]);
    setHTML(
      root,
      html`<div class="alert alert-info">The Guest Booking System, Restaurant POS, Housekeeping System and HR/Payroll are separate applications. They connect to this PMS through authenticated endpoints under <code>/api/v1/integrations</code>. Keys, secrets and webhook URLs are configured in the server's <code>.env</code> file (see docs/INTEGRATIONS.md).${status.requireHttps ? "" : " HTTPS is not enforced on this server (development)."}</div>
      <div class="grid grid-2">${status.clients.map((c) => clientCard(c, status))}</div>
      ${roomSync.error
        ? sectionError("Room synchronisation", roomSync.error)
        : html`<div class="grid grid-2">${roomSync.data.targets.map((t) => syncTargetCard(t, roomSync.data.webhooks[t.target]))}</div>
        ${syncHistoryCard(roomSync.data.jobs)}`}
      ${cleaning.error ? sectionError("Cleaning notifications", cleaning.error) : cleaningCard(cleaning.data)}
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

async function resync(btn) {
  const { resync: target, label: name } = btn.dataset;
  if (!(await confirmDialog(`Queue every room for ${name}? Rooms it already has are updated, new ones are created. Nothing is deleted.`, { confirmLabel: "Sync all rooms" }))) return;
  try {
    const r = await withBusy(btn, () => api.post("/admin/integrations/room-sync/resync", { target }));
    toast(r.blocked ? `${r.queued} room(s) queued. Not sent yet: ${r.blocked}` : `${r.queued} room(s) queued for ${name}.`, r.blocked ? "warning" : "success");
    load();
  } catch (err) {
    toastError(err);
  }
}

async function retrySync(btn) {
  try {
    const job = await withBusy(btn, () => api.post(`/admin/integrations/room-sync/${btn.dataset.retrySync}/retry`));
    const done = job.status === "SYNCED";
    toast(done ? `Room ${job.roomNumber} synchronised.` : `Room ${job.roomNumber}: ${label(job.status)}${job.lastError ? ` (${job.lastError})` : ""}`, done ? "success" : "warning");
    load();
  } catch (err) {
    toastError(err);
  }
}

root.addEventListener("change", (e) => {
  if (e.target.id !== "sync-status-filter") return;
  syncFilter = e.target.value;
  load();
});

root.addEventListener("click", async (e) => {
  if (e.target.closest("[data-reload]")) return load();
  const resyncBtn = e.target.closest("[data-resync]");
  if (resyncBtn) return resync(resyncBtn);
  const syncBtn = e.target.closest("[data-retry-sync]");
  if (syncBtn) return retrySync(syncBtn);
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
