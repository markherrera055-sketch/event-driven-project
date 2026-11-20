import "../core/shell.js";
import { api } from "../core/api.js";
import { $, html, setHTML, money, dateTime, shortDate, badge, errorHTML, emptyHTML, session } from "../core/ui.js";

const root = $("#page-root");

const stat = (label, value, sub, accent, href) => html`
  <${href ? "a" : "div"} class="stat accent-${accent}" ${href ? html`href="${href}"` : ""}>
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${sub ? html`<div class="stat-sub">${sub}</div>` : ""}
  </${href ? "a" : "div"}>`;

/** StayBook online reservations: rooms held for arriving online guests, and sync problems. */
const onlineCard = (o) => html`<div class="card">
  <div class="card-head"><h2>Online reservations</h2><a href="/front-desk/online-reservations" class="small">Open →</a></div>
  ${o.problemsLast7Days ? html`<div class="card-body"><div class="alert alert-warning"><a href="/front-desk/online-reservations?view=issues">${o.problemsLast7Days} StayBook sync issue${o.problemsLast7Days === 1 ? "" : "s"} in the last 7 days →</a></div></div>` : ""}
  <div class="card-body"><dl class="dl small">
    <dt>Arriving today</dt><dd>${o.arrivalsToday}</dd>
    <dt>Upcoming</dt><dd>${o.upcoming}</dd>
    <dt>Received today</dt><dd>${o.receivedToday}</dd>
  </dl></div>
  ${o.nextArrivals.length
    ? html`<ul class="notice-list">${o.nextArrivals.map(
        (r) => html`<li><span class="dot"></span><span><a href="/front-desk/online-reservations?open=${r.id}">${shortDate(r.checkInDate)} · ${r.guestName}</a>
          <span class="muted small">· ${r.room ? `Room ${r.room.roomNumber}` : "no room"} · ${r.bookingReference}</span></span></li>`
      )}</ul>`
    : html`<div class="card-body muted small">No online arrivals in the next 7 days.</div>`}
</div>`;

async function load() {
  try {
    const [d, online] = await Promise.all([api.get("/dashboard"), api.get("/online-reservations/summary").catch(() => null)]);
    const notices = d.notifications.filter((n) => !n.adminOnly || session.isAdmin);
    setHTML(
      root,
      html`
      <div class="stats">
        ${stat("Total rooms", d.rooms.total, [d.rooms.maintenance ? `${d.rooms.maintenance} under maintenance` : "", d.rooms.outOfService ? `${d.rooms.outOfService} out of service` : ""].filter(Boolean).join(" · ") || "In inventory", "slate", "/rooms")}
        ${stat("Vacant", d.rooms.vacant, `${d.rooms.ready} ready · ${d.rooms.needsCleaning} need cleaning`, "green", "/rooms")}
        ${stat("Occupied", d.rooms.occupied, `${d.rooms.occupancyRate}% occupancy`, "blue", "/front-desk/in-house")}
        ${stat("Arrivals today", d.arrivals.today, d.arrivals.unassigned ? `${d.arrivals.unassigned} without room` : "Confirmed reservations", "violet", "/front-desk/reservations?view=arrivals")}
        ${stat("Departures today", d.departures.today, d.departures.overdue ? `${d.departures.overdue} overdue` : "Expected check-outs", "amber", "/front-desk/reservations?view=departures")}
        ${stat("Revenue today", money(d.revenueToday), `${d.openBills} open bill(s)`, "green", "/reports")}
      </div>

      <div class="grid grid-main">
        <div class="card">
          <div class="card-head"><h2>Recent payments</h2><a href="/front-desk/in-house" class="small">In-house guests →</a></div>
          <div class="card-body flush">
            ${
              d.recentPayments.length
                ? html`<div class="table-wrap"><table class="table">
                    <thead><tr><th>Time</th><th>Guest</th><th>Room</th><th>Method</th><th>Status</th><th class="right">Amount</th></tr></thead>
                    <tbody>${d.recentPayments.map(
                      (p) => html`<tr class="clickable" data-href="/front-desk/stays/${p.stayId}">
                        <td class="nowrap">${dateTime(p.processedAt)}</td>
                        <td>${p.guestName}<div class="sub">${p.reservationCode}</div></td>
                        <td>${p.roomNumber}</td>
                        <td>${p.method.replace("_", "-")}</td>
                        <td>${badge(p.status)}</td>
                        <td class="num">${money(p.amount)}</td></tr>`
                    )}</tbody></table></div>`
                : emptyHTML("No payments yet", "Payments taken at checkout will appear here.")
            }
          </div>
        </div>

        <div class="stack">
          ${online ? onlineCard(online) : ""}
          <div class="card">
            <div class="card-head"><h2>Notifications</h2></div>
            ${
              notices.length
                ? html`<ul class="notice-list">${notices.map(
                    (n) => html`<li><span class="dot ${n.level}"></span><span>${n.href ? html`<a href="${n.href}">${n.text}</a>` : n.text}</span></li>`
                  )}</ul>`
                : html`<div class="card-body muted">Nothing needs attention right now.</div>`
            }
          </div>
          <div class="card">
            <div class="card-head"><h2>Occupancy</h2><span class="strong">${d.rooms.occupancyRate}%</span></div>
            <div class="card-body">
              <div class="meter"><span data-w="${d.rooms.occupancyRate}"></span></div>
              <dl class="dl small" >
                <dt>In-house guests</dt><dd>${d.inHouse}</dd>
                <dt>Late arrivals</dt><dd>${d.arrivals.late}</dd>
                <dt>Overdue departures</dt><dd>${d.departures.overdue}</dd>
                <dt>Business date</dt><dd>${d.date}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>`
    );
  } catch (err) {
    setHTML(root, errorHTML(err));
  }
}

root.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-href]");
  if (row) window.location.href = row.dataset.href;
});

load();
