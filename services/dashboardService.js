/**
 * Dashboard: operational summary derived from the existing records (no extra
 * tables). Room counts follow the room status lifecycle: "vacant" = every
 * in-service room not occupied or under maintenance, split into ready
 * (AVAILABLE / RESERVED) and waiting for housekeeping (DIRTY / CLEANING).
 */
import { Op, fn, col } from "sequelize";
import {
  Room,
  Reservation,
  Bill,
  Payment,
  IntegrationOutbox,
  ROOM_STATUS,
  READY_ROOM_STATUSES,
  HOUSEKEEPING_ROOM_STATUSES,
  RESERVATION_STATUS,
  BILL_STATUS,
  PAYMENT_STATUS,
  OUTBOX_STATUS,
} from "../models/index.js";
import { today } from "../utils/dates.js";
import { config } from "../config/index.js";
import { paymentJSON } from "./serializers.js";
import { posOrderSummary } from "./posOrderReviewService.js";

const startOfHotelDay = (isoDate) => new Date(`${isoDate}T00:00:00${config.hotel.utcOffset}`);

export async function getDashboard() {
  const d = today();
  const dayStart = startOfHotelDay(d);

  const [
    totalRooms,
    vacantRooms,
    occupiedRooms,
    inactiveRooms,
    arrivalsToday,
    lateArrivals,
    unassignedArrivals,
    inHouse,
    departuresToday,
    overdueDepartures,
    openBills,
    revenueToday,
    failedPaymentsToday,
    failedWebhooks,
    needsCleaning,
  ] = await Promise.all([
    Room.count({ where: { isActive: true } }),
    Room.count({ where: { isActive: true, status: [...READY_ROOM_STATUSES, ...HOUSEKEEPING_ROOM_STATUSES] } }),
    Room.count({ where: { isActive: true, status: ROOM_STATUS.OCCUPIED } }),
    Room.count({ where: { isActive: false, archivedAt: null } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CONFIRMED, checkInDate: d } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.lt]: d } } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CONFIRMED, checkInDate: { [Op.lte]: d }, roomId: null } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CHECKED_IN } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CHECKED_IN, checkOutDate: d } }),
    Reservation.count({ where: { status: RESERVATION_STATUS.CHECKED_IN, checkOutDate: { [Op.lt]: d } } }),
    Bill.count({ where: { status: { [Op.in]: [BILL_STATUS.DRAFT, BILL_STATUS.CONFIRMED] } } }),
    Payment.findOne({
      attributes: [[fn("COALESCE", fn("SUM", col("amount")), 0), "total"]],
      where: { status: PAYMENT_STATUS.SUCCESSFUL, processedAt: { [Op.gte]: dayStart } },
      raw: true,
    }),
    Payment.count({ where: { status: PAYMENT_STATUS.FAILED, processedAt: { [Op.gte]: dayStart } } }),
    IntegrationOutbox.count({ where: { status: OUTBOX_STATUS.FAILED } }),
    Room.count({ where: { isActive: true, status: HOUSEKEEPING_ROOM_STATUSES } }),
  ]);

  const recentPayments = await Payment.findAll({
    include: [
      "receipt",
      { association: "receiver", attributes: ["id", "fullName", "role"] },
      { association: "bill", attributes: ["id", "stayId"], include: [{ association: "stay", attributes: ["id"], include: [{ association: "reservation", attributes: ["reservationCode"], include: [{ association: "guest", attributes: ["firstName", "lastName"] }, { association: "room", attributes: ["roomNumber"] }] }] }] },
    ],
    order: [["processedAt", "DESC"]],
    limit: 8,
  });

  const pos = await posOrderSummary();
  const notifications = [];
  if (pos.open) notifications.push({ level: "warning", text: `${pos.open} restaurant purchase(s) are waiting for review before they can be billed.`, href: "/front-desk/restaurant-charges" });
  if (pos.needsAdjustment) notifications.push({ level: "danger", text: `${pos.needsAdjustment} restaurant purchase(s) were voided by the POS after being billed — correct the bill.`, href: "/front-desk/restaurant-charges?status=ADDED_TO_FOLIO&needsAdjustment=true" });
  if (overdueDepartures) notifications.push({ level: "warning", text: `${overdueDepartures} guest(s) are past their check-out date.`, href: "/front-desk/reservations?view=departures" });
  if (lateArrivals) notifications.push({ level: "info", text: `${lateArrivals} confirmed reservation(s) from earlier dates have not arrived.`, href: "/front-desk/reservations?view=arrivals" });
  if (unassignedArrivals) notifications.push({ level: "warning", text: `${unassignedArrivals} arriving reservation(s) still need a room assigned.`, href: "/front-desk/reservations?view=arrivals" });
  if (needsCleaning) notifications.push({ level: "info", text: `${needsCleaning} room(s) are waiting for housekeeping.`, href: "/rooms?housekeeping=dirty" });
  if (failedPaymentsToday) notifications.push({ level: "info", text: `${failedPaymentsToday} payment attempt(s) failed today.` });
  if (failedWebhooks) notifications.push({ level: "danger", text: `${failedWebhooks} integration notification(s) could not be delivered.`, href: "/admin/integrations", adminOnly: true });

  return {
    date: d,
    rooms: { total: totalRooms, vacant: vacantRooms, occupied: occupiedRooms, outOfService: inactiveRooms, occupancyRate: totalRooms ? Math.round((occupiedRooms / totalRooms) * 100) : 0, needsCleaning, ready: await Room.count({ where: { isActive: true, status: READY_ROOM_STATUSES } }), maintenance: await Room.count({ where: { isActive: true, status: ROOM_STATUS.MAINTENANCE } }) },
    arrivals: { today: arrivalsToday, late: lateArrivals, unassigned: unassignedArrivals },
    inHouse,
    departures: { today: departuresToday, overdue: overdueDepartures },
    openBills,
    revenueToday: Number(revenueToday?.total || 0),
    recentPayments: recentPayments.map((p) => ({
      ...paymentJSON(p),
      stayId: p.bill?.stay?.id,
      reservationCode: p.bill?.stay?.reservation?.reservationCode,
      guestName: p.bill?.stay?.reservation?.guest ? `${p.bill.stay.reservation.guest.firstName} ${p.bill.stay.reservation.guest.lastName}` : null,
      roomNumber: p.bill?.stay?.reservation?.room?.roomNumber,
    })),
    notifications,
    restaurantCharges: pos,
  };
}
