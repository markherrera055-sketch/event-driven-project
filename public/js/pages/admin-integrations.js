/**
 * Admin Console — integration monitoring for the connected hotel systems
 * (Guest Booking, Restaurant POS, Housekeeping, HR/Payroll).
 * Shows configuration status (never the keys), the outbound webhook log with
 * a manual retry, and the inbound request log.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, dateTime, badge, errorHTML, emptyHTML, withBusy, toast, toastError } from "../core/ui.js";

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

async function load() {
  try {
    const { status, outbox, requests } = await api.get("/admin/integrations");
    setHTML(
      root,
      html`<div class="alert alert-info">The Guest Booking System, Restaurant POS, Housekeeping System and HR/Payroll are separate applications. They connect to this PMS through authenticated endpoints under <code>/api/v1/integrations</code>. Keys, secrets and webhook URLs are configured in the server's <code>.env</code> file (see docs/INTEGRATIONS.md).${status.requireHttps ? "" : " HTTPS is not enforced on this server (development)."}</div>
      <div class="grid grid-2">${status.clients.map((c) => clientCard(c, status))}</div>
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

root.addEventListener("click", async (e) => {
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
