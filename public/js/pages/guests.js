import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, dateTime, errorHTML, emptyHTML, loadingHTML, pagerHTML, debounce } from "../core/ui.js";

const root = $("#page-root");
const state = { search: "", page: 1 };

setHTML(
  root,
  html`<div class="card"><div class="toolbar"><input type="search" id="search" placeholder="Name, email or phone…" aria-label="Search guests"></div><div id="results"></div></div>`
);
const results = $("#results");

async function load() {
  setHTML(results, loadingHTML());
  try {
    const { data, meta } = await api.list("/guests", state);
    if (!data.length) return setHTML(results, emptyHTML("No guests found", "Guests are added when a reservation is made."));
    setHTML(
      results,
      html`<div class="table-wrap"><table class="table"><thead><tr><th>Guest</th><th>Email</th><th>Phone</th><th>Since</th></tr></thead><tbody>
      ${data.map((g) => html`<tr class="clickable" data-href="/guests/${g.id}"><td class="strong">${g.lastName}, ${g.firstName}</td><td>${g.email || "—"}</td><td>${g.phone || "—"}</td><td>${dateTime(g.createdAt)}</td></tr>`)}
      </tbody></table></div>${pagerHTML(meta)}`
    );
  } catch (err) {
    setHTML(results, errorHTML(err));
  }
}

root.addEventListener("click", (e) => {
  const p = e.target.closest("button[data-goto-page]");
  if (p) {
    state.page = Number(p.dataset.gotoPage);
    return load();
  }
  const row = e.target.closest("tr[data-href]");
  if (row) window.location.href = row.dataset.href;
});
$("#search").addEventListener("input", debounce((e) => { state.search = e.target.value.trim(); state.page = 1; load(); }));
load();
