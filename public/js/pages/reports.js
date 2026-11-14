/** Read-only reports built from operational records (occupancy, movements, revenue, housekeeping). */
import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, money, shortDate, label, errorHTML, emptyHTML, loadingHTML, formValues } from "../core/ui.js";

const root = $("#page-root");
const iso = (d) => d.toLocaleDateString("en-CA");
const to = new Date();
const from = new Date(Date.now() - 6 * 86400000);

setHTML(
  root,
  html`<form class="card toolbar" id="range">
      <div><label for="from">From</label><input type="date" id="from" name="from" value="${iso(from)}" required></div>
      <div><label for="to">To</label><input type="date" id="to" name="to" value="${iso(to)}" required></div>
      <div><label>&nbsp;</label><button class="btn btn-primary" type="submit">Run report</button></div>
      <div><label>&nbsp;</label><button class="btn" type="button" id="print">Print</button></div>
    </form><div id="report"></div>`
);
const out = $("#report");

const stat = (l, v, sub) => html`<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ""}</div>`;

/** Simple bar chart (heights via data-h, applied by setHTML — no inline styles). */
const bars = (rows, value, fmt) => {
  if (!rows.length) return emptyHTML("No data in this range");
  const max = Math.max(1, ...rows.map(value));
  return html`<div class="bars">${rows.map((r) => html`<div class="bar" title="${shortDate(r.date)}: ${fmt(value(r))}"><em>${fmt(value(r))}</em><span data-h="${Math.round((value(r) / max) * 85)}"></span></div>`)}</div>
    <div class="bar-labels">${rows.map((r) => html`<span>${shortDate(r.date)}</span>`)}</div>`;
};

async function run(range) {
  setHTML(out, loadingHTML("Building report…"));
  try {
    const r = await api.get("/reports/summary", range);
    const s = r.summary;
    const byDay = (list, key) => r.occupancy.map((d) => ({ date: d.date, v: (list.find((x) => x.date === d.date) || {})[key] || 0 }));
    setHTML(
      out,
      html`<div class="stats">
        ${stat("Average occupancy", `${s.averageOccupancyRate}%`, `${shortDate(r.from)} – ${shortDate(r.to)}`)}
        ${stat("Check-ins", s.checkIns)}${stat("Check-outs", s.checkOuts)}
        ${stat("Revenue collected", money(s.revenue), `${s.successfulPayments} payment(s)`)}
        ${stat("Failed payment attempts", s.failedPayments)}${stat("Cancellations", s.cancellations)}
      </div>
      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>Occupancy by night</h2><span class="muted small">occupied rooms ÷ total rooms</span></div>
          <div class="card-body">${bars(r.occupancy, (d) => d.rate, (v) => `${v}%`)}</div></div>
        <div class="card"><div class="card-head"><h2>Revenue by day</h2></div>
          <div class="card-body">${bars(byDay(r.revenueByDay, "total").map((d) => ({ date: d.date, total: d.v })), (d) => d.total, (v) => (v ? money(v).replace(/\.00$/, "") : "0"))}</div></div>
        <div class="card"><div class="card-head"><h2>Check-ins / check-outs</h2></div><div class="card-body flush"><div class="table-wrap"><table class="table">
          <thead><tr><th>Date</th><th class="right">Check-ins</th><th class="right">Check-outs</th><th class="right">Rooms cleaned</th></tr></thead><tbody>
          ${r.occupancy.map((d) => {
            const m = r.movements.find((x) => x.date === d.date) || {};
            const h = r.housekeeping.find((x) => x.date === d.date) || {};
            return html`<tr><td>${shortDate(d.date)}</td><td class="num">${m.checkIns || 0}</td><td class="num">${m.checkOuts || 0}</td><td class="num">${h.roomsCleaned || 0}</td></tr>`;
          })}</tbody></table></div></div></div>
        <div class="card"><div class="card-head"><h2>Revenue breakdown</h2></div><div class="card-body flush"><div class="table-wrap"><table class="table">
          <thead><tr><th>Payment method</th><th class="right">Payments</th><th class="right">Amount</th></tr></thead><tbody>
          ${r.revenueByMethod.length ? r.revenueByMethod.map((m) => html`<tr><td>${label(m.method)}</td><td class="num">${m.payments}</td><td class="num">${money(m.total)}</td></tr>`) : html`<tr><td colspan="3" class="muted">No payments</td></tr>`}
          </tbody></table>
          <table class="table"><thead><tr><th>Bills paid in range (${r.billComposition.bills})</th><th class="right">Amount</th></tr></thead><tbody>
            <tr><td>Room charges</td><td class="num">${money(r.billComposition.roomCharges)}</td></tr>
            <tr><td>Folio charges (POS)</td><td class="num">${money(r.billComposition.folioCharges)}</td></tr>
            <tr><td>Adjustments</td><td class="num">${money(r.billComposition.adjustments)}</td></tr></tbody>
            <tfoot><tr><td>Total billed</td><td class="num">${money(r.billComposition.total)}</td></tr></tfoot></table></div></div></div>
      </div>`
    );
  } catch (err) {
    setHTML(out, errorHTML(err));
  }
}

$("#range").addEventListener("submit", (e) => {
  e.preventDefault();
  run(formValues(e.target));
});
$("#print").addEventListener("click", () => window.print());
run({ from: iso(from), to: iso(to) });
