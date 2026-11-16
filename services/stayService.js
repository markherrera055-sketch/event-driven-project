/**
 * Check-in and Stay module (Figure 7 composite structure):
 *   StayController.checkIn  → VerificationGuard.isVerified → StayRepository.save
 *                           → Room Status: RESERVED / AVAILABLE → OCCUPIED
 * REQ-3: "The system shall check in only verified guests and save a stay record."
 * All steps run in one transaction; any failure rolls everything back.
 * Publishes GuestCheckedIn.
 */
import { Op } from "sequelize";
import { Reservation, Stay, RESERVATION_STATUS, STAY_STATUS, ROOM_STATUS, HOUSEKEEPING_ROOM_STATUSES, STATUS_CHANGE_SOURCE } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { today } from "../utils/dates.js";
import { isVerified } from "./verificationService.js";
import { transition, lockRoomRow, STATUS_REASON } from "./roomStatusService.js";
import { stayJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { emit, EVENTS } from "./domainEvents.js";
import { guestCheckedInData } from "./eventPayloads.js";
import { getBillTotals } from "./billingService.js";
import { logger } from "../utils/logger.js";

/** Refuses check-in into a room that is not ready, with a message the receptionist can act on. */
const assertRoomReadyForCheckIn = (room) => {
  if (room.status === ROOM_STATUS.MAINTENANCE) {
    throw conflict("ROOM_UNDER_MAINTENANCE", `Room ${room.roomNumber} is under maintenance. Assign another room first.`);
  }
  if (HOUSEKEEPING_ROOM_STATUSES.includes(room.status)) {
    throw conflict("ROOM_NOT_READY", `Room ${room.roomNumber} is ${room.status} — it has not been cleaned since the last guest. Wait for housekeeping or mark it clean.`);
  }
  if (room.status === ROOM_STATUS.OCCUPIED) {
    throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is still occupied.`);
  }
};

export async function checkIn(reservationId, actor) {
  const stayId = await withTransaction(null, async (t) => {
    const reservation = await Reservation.findByPk(reservationId, {
      include: ["room", "guest"],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Reservation },
    });
    if (!reservation) throw notFound("Reservation");
    if (reservation.status !== RESERVATION_STATUS.CONFIRMED) {
      throw conflict("RESERVATION_NOT_CHECKIN_READY", `Reservation ${reservation.reservationCode} is ${reservation.status}.`);
    }
    const d = today();
    if (d < reservation.checkInDate) {
      throw conflict("TOO_EARLY", `Check-in for ${reservation.reservationCode} opens on ${reservation.checkInDate}.`);
    }
    if (d >= reservation.checkOutDate) {
      throw conflict("RESERVATION_EXPIRED", "The reservation's check-out date has passed. Modify the dates before checking in.");
    }
    if (!reservation.roomId) {
      throw conflict("ROOM_NOT_ASSIGNED", "Assign a room to this reservation before checking in.");
    }
    const room = await lockRoomRow(reservation.roomId, t);
    assertRoomReadyForCheckIn(room);
    if (!(await isVerified(reservation.id, t))) {
      throw conflict("IDENTITY_NOT_VERIFIED", "The guest's identity must be verified before check-in.");
    }

    await transition(
      room,
      ROOM_STATUS.OCCUPIED,
      { reason: STATUS_REASON.CHECK_IN, source: STATUS_CHANGE_SOURCE.FRONT_DESK, actor, reference: reservation.reservationCode },
      t
    );
    const stay = await Stay.create(
      { reservationId: reservation.id, checkInAt: new Date(), checkedInBy: actor.id, status: STAY_STATUS.IN_HOUSE },
      { transaction: t }
    );
    await reservation.update({ status: RESERVATION_STATUS.CHECKED_IN }, { transaction: t });

    await emit(EVENTS.GUEST_CHECKED_IN, guestCheckedInData(stay, reservation, room, reservation.guest), { transaction: t });
    logger.info("check_in", { reservationId: reservation.id, stayId: stay.id, roomId: reservation.roomId, by: actor.id });
    return stay.id;
  });
  return getStay(stayId);
}

const stayInclude = [
  { association: "reservation", include: ["guest", "room"] },
  { association: "checkInStaff", attributes: ["id", "fullName", "role"] },
  { association: "checkOutStaff", attributes: ["id", "fullName", "role"] },
  { association: "charges", required: false },
  {
    association: "bill",
    include: [
      { association: "adjustments", include: [{ association: "adjuster", attributes: ["id", "fullName", "role"] }] },
      {
        association: "payments",
        include: ["receipt", { association: "receiver", attributes: ["id", "fullName", "role"] }],
      },
      { association: "generator", attributes: ["id", "fullName", "role"] },
    ],
  },
];

export async function getStay(id) {
  const stay = await Stay.findByPk(id, { include: stayInclude });
  if (!stay) throw notFound("Stay");
  const json = stayJSON(stay);
  // Sorted here: Sequelize does not map underscored column names in nested ORDER BY.
  json.charges.sort((a, b) => new Date(a.transactionAt) - new Date(b.transactionAt));
  json.bill?.payments?.sort((a, b) => a.attemptNo - b.attemptNo);
  json.bill?.adjustments?.sort((a, b) => new Date(a.adjustedAt) - new Date(b.adjustedAt));
  json.postedChargesTotal = Number(
    stay.charges.reduce((s, c) => s + Math.round(Number(c.amount) * 100), 0) / 100
  );
  if (json.bill) json.bill.totals = await getBillTotals(json.bill.id);
  return json;
}

export async function listStays({ status = STAY_STATUS.IN_HOUSE, search } = {}) {
  const where = { status };
  if (search) {
    const like = { [Op.like]: `%${search}%` };
    where[Op.or] = [
      { "$reservation.reservation_code$": like },
      { "$reservation.guest.first_name$": like },
      { "$reservation.guest.last_name$": like },
      { "$reservation.room.room_number$": like },
    ];
  }
  const stays = await Stay.findAll({
    where,
    include: [{ association: "reservation", required: true, include: ["guest", "room"] }, "bill"],
    order: [["checkInAt", "DESC"]],
    limit: 200,
  });
  return stays.map(stayJSON);
}
