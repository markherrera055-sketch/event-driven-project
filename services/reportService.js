/**
 * Reports (read-only). Everything is computed from the operational records
 * (reservations, stays, payments, folio charges) — no report tables.
 * Range is inclusive and limited to 92 days.
 */
import { QueryTypes } from "sequelize";
import { sequelize, Room } from "../models/index.js";
import { validationError } from "../utils/errors.js";
import { addDays, eachNight, nightsBetween } from "../utils/dates.js";
import { config } from "../config/index.js";

const MAX_DAYS = 92;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

export async function buildReport({ from, to }) {
  if (to < from) throw validationError({ to: "End date must be on or after the start date." });
  if (nightsBetween(from, to) + 1 > MAX_DAYS) throw validationError({ to: `The range cannot exceed ${MAX_DAYS} days.` });

  const toExclusive = addDays(to, 1);
  const tz = config.hotel.utcOffset;
  // Convert stored DATETIMEs (hotel offset) to calendar dates.
  const params = { from, to, toExclusive, startTs: `${from} 00:00:00`, endTs: `${toExclusive} 00:00:00`, tz };

  const totalRooms = await Room.count({ where: { isActive: true } });

  // Occupancy: a stay occupies a room on each night from its check-in date up to (not incl.) its check-out date (or today if in-house).
  const stays = await q(
    `SELECT DATE_FORMAT(s.check_in_at, '%Y-%m-%d') AS inDate, DATE_FORMAT(COALESCE(s.check_out_at, NOW()), '%Y-%m-%d') AS outDate
       FROM stays s
      WHERE s.check_in_at < :endTs AND (s.check_out_at IS NULL OR s.check_out_at >= :startTs)`,
    params
  );
  const days = eachNight(from, toExclusive);
  const occupancy = days.map((day) => {
    const occupied = stays.filter((s) => s.inDate <= day && (s.outDate > day || (s.outDate === day && s.inDate === day))).length;
    return { date: day, occupiedRooms: occupied, totalRooms, rate: totalRooms ? Math.round((occupied / totalRooms) * 100) : 0 };
  });

  const movements = await q(
    `SELECT d AS date, SUM(ins) AS checkIns, SUM(outs) AS checkOuts FROM (
        SELECT DATE_FORMAT(check_in_at, '%Y-%m-%d') AS d, 1 AS ins, 0 AS outs FROM stays WHERE check_in_at >= :startTs AND check_in_at < :endTs
        UNION ALL
        SELECT DATE_FORMAT(check_out_at, '%Y-%m-%d'), 0, 1 FROM stays WHERE check_out_at >= :startTs AND check_out_at < :endTs
      ) x GROUP BY d ORDER BY d`,
    params
  );

  const revenueByDay = await q(
    `SELECT DATE_FORMAT(processed_at, '%Y-%m-%d') AS date, SUM(amount) AS total, COUNT(*) AS payments
       FROM payments WHERE status = 'SUCCESSFUL' AND processed_at >= :startTs AND processed_at < :endTs
      GROUP BY DATE_FORMAT(processed_at, '%Y-%m-%d') ORDER BY date`,
    params
  );
  const revenueByMethod = await q(
    `SELECT method, SUM(amount) AS total, COUNT(*) AS payments
       FROM payments WHERE status = 'SUCCESSFUL' AND processed_at >= :startTs AND processed_at < :endTs
      GROUP BY method ORDER BY method`,
    params
  );
  const [paymentAttempts] = await q(
    `SELECT SUM(status = 'SUCCESSFUL') AS successful, SUM(status = 'FAILED') AS failed
       FROM payments WHERE processed_at >= :startTs AND processed_at < :endTs`,
    params
  );
  // Revenue composition of bills paid in the range (room vs folio charges vs adjustments).
  const [composition] = await q(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(v.room_charge),0) AS roomCharges, COALESCE(SUM(v.charges_total),0) AS folioCharges,
            COALESCE(SUM(v.adjustments_total),0) AS adjustments, COALESCE(SUM(v.total_due),0) AS total
       FROM bills b JOIN v_bill_total v ON v.bill_id = b.id
      WHERE b.status = 'PAID' AND b.paid_at >= :startTs AND b.paid_at < :endTs`,
    params
  );
  const cancellations = await q(
    `SELECT source, COUNT(*) AS count FROM reservations
      WHERE status = 'CANCELLED' AND cancelled_at >= :startTs AND cancelled_at < :endTs GROUP BY source`,
    params
  );
  const housekeeping = await q(
    `SELECT DATE_FORMAT(last_cleaned_at, '%Y-%m-%d') AS date, COUNT(*) AS roomsCleaned FROM rooms
      WHERE last_cleaned_at >= :startTs AND last_cleaned_at < :endTs GROUP BY DATE_FORMAT(last_cleaned_at, '%Y-%m-%d') ORDER BY date`,
    params
  );

  const num = (x) => Number(x || 0);
  const avgOcc = occupancy.length ? Math.round(occupancy.reduce((s, d) => s + d.rate, 0) / occupancy.length) : 0;
  return {
    from,
    to,
    summary: {
      averageOccupancyRate: avgOcc,
      checkIns: movements.reduce((s, m) => s + num(m.checkIns), 0),
      checkOuts: movements.reduce((s, m) => s + num(m.checkOuts), 0),
      revenue: num(revenueByMethod.reduce((s, r) => s + Math.round(num(r.total) * 100), 0)) / 100,
      successfulPayments: num(paymentAttempts?.successful),
      failedPayments: num(paymentAttempts?.failed),
      cancellations: cancellations.reduce((s, c) => s + num(c.count), 0),
    },
    occupancy,
    movements: movements.map((m) => ({ date: m.date, checkIns: num(m.checkIns), checkOuts: num(m.checkOuts) })),
    revenueByDay: revenueByDay.map((r) => ({ date: r.date, total: num(r.total), payments: num(r.payments) })),
    revenueByMethod: revenueByMethod.map((r) => ({ method: r.method, total: num(r.total), payments: num(r.payments) })),
    billComposition: {
      bills: num(composition?.bills),
      roomCharges: num(composition?.roomCharges),
      folioCharges: num(composition?.folioCharges),
      adjustments: num(composition?.adjustments),
      total: num(composition?.total),
    },
    cancellations: cancellations.map((c) => ({ source: c.source, count: num(c.count) })),
    housekeeping: housekeeping.map((h) => ({ date: h.date, roomsCleaned: num(h.roomsCleaned) })),
  };
}
