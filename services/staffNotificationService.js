/**
 * Staff notifications — what the bell, the sidebar count and the Online
 * Reservations page show to front-desk staff.
 *
 * Delivery is by POLLING: every staff page asks GET /notifications/summary
 * every 30 seconds while the tab is visible (public/js/core/notifications.js).
 * There is no push channel (WebSocket / SSE), so a notification can take up to
 * ~30 seconds to appear.
 *
 * Writing:
 *  - notify() is called by the StayBook adapter INSIDE the transaction of the
 *    booking change, so a notification exists exactly when the change was
 *    committed; refused requests are recorded outside the failed transaction.
 *  - dedupeKey is unique and the insert is INSERT IGNORE: duplicate deliveries,
 *    retries and races never produce a second notification.
 * Reading: every receptionist and administrator sees every notification;
 * read state is per user.
 */
import { Op, QueryTypes } from "sequelize";
import { sequelize, StaffNotification, StaffNotificationRead, NOTIFICATION_CATEGORY, PROBLEM_NOTIFICATION_CATEGORIES } from "../models/index.js";
import { notFound } from "../utils/errors.js";
import { pageMeta } from "../utils/http.js";

const cut = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/**
 * Records a notification once per dedupeKey. Returns true when it was new.
 * Safe inside the caller's transaction: INSERT IGNORE never aborts it.
 */
export async function notify(
  { category, title, message, reservationId = null, externalBookingId = null, bookingReference = null, roomNumber = null, guestName = null, details = null, dedupeKey, sourceSystem = "STAYBOOK" },
  { transaction } = {}
) {
  const [row] = await StaffNotification.bulkCreate(
    [
      {
        category,
        sourceSystem,
        title: cut(title, 160),
        message: cut(message, 500),
        reservationId,
        externalBookingId,
        bookingReference: cut(bookingReference, 100),
        roomNumber: cut(roomNumber, 10),
        guestName: cut(guestName, 160),
        details,
        dedupeKey: cut(dedupeKey, 191),
      },
    ],
    { ignoreDuplicates: true, transaction }
  );
  // With INSERT IGNORE MySQL reports no id for a skipped row.
  return !!row?.id;
}

const unreadLiteral = (userId) =>
  sequelize.literal(`(SELECT r.notification_id FROM staff_notification_reads r WHERE r.user_id = ${Number(userId)})`);

const notificationJSON = (n, readIds) => ({
  id: n.id,
  category: n.category,
  problem: PROBLEM_NOTIFICATION_CATEGORIES.includes(n.category),
  title: n.title,
  message: n.message,
  reservationId: n.reservationId,
  bookingReference: n.bookingReference,
  roomNumber: n.roomNumber,
  guestName: n.guestName,
  details: n.details,
  createdAt: n.createdAt,
  read: readIds.has(n.id),
});

async function readSet(userId, ids) {
  if (!ids.length) return new Set();
  const rows = await StaffNotificationRead.findAll({ where: { userId, notificationId: ids }, attributes: ["notificationId"] });
  return new Set(rows.map((r) => r.notificationId));
}

/** Newest first. unread: only the user's unread ones. problems: only ROOM_CONFLICT / SYNC_FAILED. */
export async function listNotifications(user, { unread, problems, category, reservationId, page = 1, limit = 20, offset = 0 } = {}) {
  const where = {};
  if (category) where.category = category;
  else if (problems) where.category = PROBLEM_NOTIFICATION_CATEGORIES;
  if (reservationId) where.reservationId = reservationId;
  if (unread) where.id = { [Op.notIn]: unreadLiteral(user.id) };
  const { rows, count } = await StaffNotification.findAndCountAll({ where, order: [["id", "DESC"]], limit, offset });
  const read = await readSet(user.id, rows.map((n) => n.id));
  return { data: rows.map((n) => notificationJSON(n, read)), meta: pageMeta({ page, limit }, count) };
}

/**
 * Badge counts for the polling client. Includes the newest unread
 * notification (title / message) so a toast can announce it.
 */
export async function notificationSummary(user) {
  const rows = await sequelize.query(
    `SELECT n.category, COUNT(*) AS n, MAX(n.id) AS latest
       FROM staff_notifications n
       LEFT JOIN staff_notification_reads r ON r.notification_id = n.id AND r.user_id = :userId
      WHERE r.notification_id IS NULL
      GROUP BY n.category`,
    { replacements: { userId: user.id }, type: QueryTypes.SELECT }
  );
  const byCategory = Object.fromEntries(Object.values(NOTIFICATION_CATEGORY).map((c) => [c, 0]));
  let unread = 0;
  let latestId = null;
  for (const r of rows) {
    byCategory[r.category] = Number(r.n);
    unread += Number(r.n);
    latestId = Math.max(latestId ?? 0, Number(r.latest));
  }
  const latest = latestId ? await StaffNotification.findByPk(latestId) : null;
  return {
    unread,
    problems: PROBLEM_NOTIFICATION_CATEGORIES.reduce((sum, c) => sum + byCategory[c], 0),
    byCategory,
    latestUnread: latest ? notificationJSON(latest, new Set()) : null,
  };
}

export async function markRead(user, id) {
  const n = await StaffNotification.findByPk(id, { attributes: ["id"] });
  if (!n) throw notFound("Notification");
  await StaffNotificationRead.bulkCreate([{ notificationId: id, userId: user.id, readAt: new Date() }], { ignoreDuplicates: true });
  return { id, read: true };
}

/**
 * Marks the user's notifications read. upToId (the newest one the user has
 * seen) keeps a notification that arrived meanwhile unread; reservationId
 * limits it to one reservation (opening its details).
 */
export async function markAllRead(user, { upToId, reservationId } = {}) {
  const conditions = ["1 = 1"];
  if (upToId) conditions.push("n.id <= :upToId");
  if (reservationId) conditions.push("n.reservation_id = :reservationId");
  const [, meta] = await sequelize.query(
    `INSERT IGNORE INTO staff_notification_reads (notification_id, user_id, read_at)
     SELECT n.id, :userId, NOW() FROM staff_notifications n WHERE ${conditions.join(" AND ")}`,
    { replacements: { userId: user.id, upToId: upToId || 0, reservationId: reservationId || 0 } }
  );
  return { marked: typeof meta === "number" ? meta : meta?.affectedRows ?? 0 };
}
