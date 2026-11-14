/**
 * Admin Console — integration monitoring (future POS / Hotel Reservation System).
 * Shows configuration status (never the keys), the inbound request log and the
 * outbound webhook outbox with a manual retry.
 */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, dateTime, badge, errorHTML, emptyHTML, withBusy, toast, toastError } from "../core/ui.js";

const root = $("#page-root");

const yesNo = (v, yes = "Configured", no = "Not configured") => (v ? html`<span class="badge badge-green">${yes}</span>` : html`<span class="badge">${no}</span>`);

async function load() {
  try {
    const { status, outbox, requests } = await api.get("/admin/integrations");
    setHTML(
      root,
      html`<div class="alert alert-info">The POS and the Hotel Reservation System are separate applications. This PMS exposes versioned, API-key protected endpoints for them under <code>/api/v1/integrations</code>. Keys and webhook URLs are configured in the server's <code>.env</code> file (see docs/INTEGRATIONS.md).</div>
      <div class="grid grid-2">
        ${[["POS system", status.pos, "/api/v1/integrations/pos"], ["Hotel Reservation System", status.reservations, "/api/v1/integrations/reservations"]].map(
          ([name, s, base]) => html`<div class="card"><div class="card-head"><h2>${name}</h2>${yesNo(s.enabled, "Enabled", "Disabled")}</div><div class="card-body"><dl class="dl">
            <dt>Base URL</dt><dd class="mono">${base}</dd><dt>Inbound API key</dt><dd>${yesNo(s.enabled)}</dd>
            <dt>Outbound webhooks</dt><dd>${yesNo(s.webhookConfigured)}</dd><dt>Webhook signing</dt><dd>${yesNo(s.signed, "HMAC-SHA256", "Unsigned")}</dd>
            <dt>Rate limit</dt><dd>${status.rateLimitPerMinute} requests / minute</dd></dl></div></div>`
        )}
      </div>
      <div class="card"><div class="card-head"><h2>Outbound webhooks</h2><span class="muted small">latest 50</span></div><div class="card-body flush">${
        outbox.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Target</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Created</th><th></th></tr></thead><tbody>
            ${outbox.map((o) => html`<tr><td>${o.id}</td><td>${o.target}</td><td class="mono">${o.eventType}</td><td>${badge(o.status)}</td><td class="num">${o.attempts}</td>
              <td class="small">${o.lastError || ""}</td><td class="nowrap">${dateTime(o.createdAt)}</td>
              <td class="right">${o.status === "FAILED" || o.status === "SKIPPED" ? html`<button class="btn btn-sm" data-retry="${o.id}">Retry</button>` : ""}</td></tr>`)}
            </tbody></table></div>`
          : emptyHTML("No webhook events yet")
      }</div></div>
      <div class="card"><div class="card-head"><h2>Inbound requests</h2><span class="muted small">latest 50</span></div><div class="card-body flush">${
        requests.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Source</th><th>Request</th><th>Idempotency key</th><th>Status</th></tr></thead><tbody>
            ${requests.map((q) => html`<tr><td class="nowrap">${dateTime(q.createdAt)}</td><td>${q.source}</td><td class="mono">${q.method} ${q.path}</td><td class="mono small">${q.idempotencyKey}</td>
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
