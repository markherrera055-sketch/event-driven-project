/**
 * Room Status module (RoomStatusUpdater: setOccupied / setVacant) and the
 * room part of the Room and Staff Admin module (Administrator.manageRooms).
 *
 * Status rules (prevent invalid transitions):
 *   VACANT ⇄ OCCUPIED      only by check-in / checkout / room move (never by hand)
 *   VACANT ⇄ MAINTENANCE   administrator; not while a guest is due in tonight
 *   isActive true ⇄ false  administrator (Inactive = out of inventory)
 * The status shown to staff (displayStatus) adds derived values:
 *   RESERVED  vacant room held by a confirmed reservation covering tonight
 *   INACTIVE  out of service (isActive = false)
 * Editing reservation information never changes a room's stored status.
 */
import { Op, fn, col, UniqueConstraintError } from "sequelize";
import { Room, Reservation, ROOM_STATUS, ACTIVE_RESERVATION_STATUSES, RESERVATION_STATUS } from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { today } from "../utils/dates.js";
import { assertRoomRemovable, lockRoomTypes, peekRoomType } from "./availabilityService.js";
import { roomJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

export const DISPLAY_STATUS = Object.freeze({
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  OCCUPIED: "OCCUPIED",
  MAINTENANCE: "MAINTENANCE",
  INACTIVE: "INACTIVE",
  DELETED: "DELETED",
});

const displayStatusOf = (room, reservedTonight) => {
  if (room.archivedAt) return DISPLAY_STATUS.DELETED;
  if (!room.isActive) return DISPLAY_STATUS.INACTIVE;
  if (room.status === ROOM_STATUS.OCCUPIED) return DISPLAY_STATUS.OCCUPIED;
  if (room.status === ROOM_STATUS.MAINTENANCE) return DISPLAY_STATUS.MAINTENANCE;
  return reservedTonight ? DISPLAY_STATUS.RESERVED : DISPLAY_STATUS.AVAILABLE;
};

/**
 * Rooms list. Archived ("deleted") rooms are hidden unless archived: true,
 * which lists only them (so they can be restored).
 */
export async function listRooms({ status, roomType, search, needsCleaning, includeInactive = false, archived = false } = {}) {
  const where = { archivedAt: archived ? { [Op.ne]: null } : null };
  if (!includeInactive && !archived) where.isActive = true;
  if (status) where.status = status;
  if (roomType) where.roomType = roomType;
  if (needsCleaning !== undefined) where.needsCleaning = needsCleaning;
  if (search) where.roomNumber = { [Op.like]: `%${search}%` };
  const rooms = await Room.findAll({
    where,
    order: [["roomNumber", "ASC"]],
    include: [
      { association: "cleaner", attributes: ["id", "fullName", "role"] },
      {
        model: Reservation,
        as: "reservations",
        required: false,
        where: { status: RESERVATION_STATUS.CHECKED_IN },
        attributes: ["id", "reservationCode", "checkOutDate"],
        include: [{ association: "guest", attributes: ["firstName", "lastName"] }],
      },
    ],
  });

  // Confirmed reservations holding a room tonight (derived "Reserved" status).
  const d = today();
  const holds = rooms.length
    ? await Reservation.findAll({
        where: {
          roomId: { [Op.in]: rooms.map((r) => r.id) },
          status: RESERVATION_STATUS.CONFIRMED,
          checkInDate: { [Op.lte]: d },
          checkOutDate: { [Op.gt]: d },
        },
        attributes: ["id", "roomId", "reservationCode", "checkInDate", "checkOutDate"],
        include: [{ association: "guest", attributes: ["firstName", "lastName"] }],
      })
    : [];
  const holdByRoom = new Map(holds.map((h) => [h.roomId, h]));

  return rooms.map((r) => {
    const current = r.reservations?.[0];
    const hold = holdByRoom.get(r.id);
    return {
      ...roomJSON(r),
      displayStatus: displayStatusOf(r, !!hold),
      currentReservation: current
        ? {
            id: current.id,
            reservationCode: current.reservationCode,
            checkOutDate: current.checkOutDate,
            guestName: `${current.guest.firstName} ${current.guest.lastName}`,
          }
        : null,
      reservedTonight: hold
        ? {
            id: hold.id,
            reservationCode: hold.reservationCode,
            checkInDate: hold.checkInDate,
            checkOutDate: hold.checkOutDate,
            guestName: `${hold.guest.firstName} ${hold.guest.lastName}`,
          }
        : null,
    };
  });
}

/** Room types are derived from the rooms themselves (roomType is an attribute of Room in the class diagram). */
export async function listRoomTypes() {
  const rows = await Room.findAll({
    where: { isActive: true },
    attributes: [
      "roomType",
      [fn("COUNT", col("id")), "roomCount"],
      [fn("MAX", col("capacity")), "maxCapacity"],
      [fn("MIN", col("nightly_rate")), "minRate"],
      [fn("MAX", col("nightly_rate")), "maxRate"],
    ],
    group: ["roomType"],
    order: [["roomType", "ASC"]],
    raw: true,
  });
  return rows.map((r) => ({
    roomType: r.roomType,
    roomCount: Number(r.roomCount),
    maxCapacity: Number(r.maxCapacity),
    minRate: Number(r.minRate),
    maxRate: Number(r.maxRate),
  }));
}

export async function getRoom(id) {
  const room = await Room.findByPk(id);
  if (!room) throw notFound("Room");
  return roomJSON(room);
}

const assertNumberFree = async (roomNumber, transaction) => {
  const taken = await Room.findOne({ where: { roomNumber }, attributes: ["id", "archivedAt"], transaction });
  if (!taken) return;
  throw conflict(
    "ROOM_NUMBER_TAKEN",
    taken.archivedAt
      ? `Room ${roomNumber} belongs to a deleted room that still has history. Restore it from "Deleted rooms" instead.`
      : `Room ${roomNumber} already exists.`,
    { roomNumber: taken.archivedAt ? "Used by a deleted room (restore it instead)." : "Already exists." }
  );
};

/** The unique index on room_number is the final guard against two simultaneous saves. */
const guardUniqueNumber = async (save) => {
  try {
    return await save();
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw conflict("ROOM_NUMBER_TAKEN", "That room number already exists.", { roomNumber: "Already exists." });
    }
    throw err;
  }
};

const ROOM_FIELDS = ["roomNumber", "roomType", "floor", "capacity", "nightlyRate", "description", "amenities"];

export async function createRoom(data, actor) {
  await assertNumberFree(data.roomNumber);
  const values = { status: data.status === ROOM_STATUS.MAINTENANCE ? ROOM_STATUS.MAINTENANCE : ROOM_STATUS.VACANT };
  for (const key of ROOM_FIELDS) if (data[key] !== undefined) values[key] = data[key];
  if (data.isActive !== undefined) values.isActive = data.isActive;
  const room = await guardUniqueNumber(() => Room.create(values));
  logger.info("room_created", { roomId: room.id, roomNumber: room.roomNumber, by: actor?.id });
  return roomJSON(room);
}

/** Active reservations assigned to the room, and those of them covering tonight. */
const assignedBookings = async (room, transaction) => {
  const d = today();
  const rows = await Reservation.findAll({
    where: { roomId: room.id, status: { [Op.in]: ACTIVE_RESERVATION_STATUSES } },
    attributes: ["id", "reservationCode", "status", "checkInDate", "checkOutDate", "numGuests"],
    order: [["checkInDate", "ASC"]],
    transaction,
  });
  return { all: rows, tonight: rows.filter((r) => r.checkInDate <= d && r.checkOutDate > d) };
};

/**
 * Locks the room together with every room of its type (same lock order as
 * bookings, see lockRoomTypes) so administration and bookings never deadlock
 * and every later read in the transaction sees committed data.
 */
const lockRoom = async (id, transaction) => {
  const peek = await peekRoomType(id);
  if (!peek) throw notFound("Room");
  const room = (await lockRoomTypes([peek.roomType], transaction)).find((r) => r.id === id);
  if (!room) throw conflict("ROOM_CHANGED", "The room was changed by someone else. Reload and try again.");
  return room;
};

const codes = (rows) => rows.slice(0, 3).map((r) => r.reservationCode).join(", ") + (rows.length > 3 ? ` and ${rows.length - 3} more` : "");

export async function updateRoom(id, changes, actor) {
  return withTransaction(null, async (transaction) => {
    const room = await lockRoom(id, transaction);
    if (room.archivedAt) throw notFound("Room");

    if (changes.roomNumber && changes.roomNumber !== room.roomNumber) await assertNumberFree(changes.roomNumber, transaction);

    const bookings = await assignedBookings(room, transaction);
    const deactivating = changes.isActive === false && room.isActive;
    const typeChanging = !!changes.roomType && changes.roomType !== room.roomType;
    const statusChanging = !!changes.status && changes.status !== room.status;

    // Status transitions. OCCUPIED is controlled by check-in / checkout / room move only.
    if (statusChanging && room.status === ROOM_STATUS.OCCUPIED) {
      throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is occupied. Its status changes automatically at checkout or room move.`);
    }
    if (statusChanging && changes.status === ROOM_STATUS.MAINTENANCE && bookings.tonight.length) {
      throw conflict("ROOM_IN_USE", `A guest is due in room ${room.roomNumber} tonight (${codes(bookings.tonight)}). Reassign the reservation first.`);
    }
    if (deactivating && (room.status === ROOM_STATUS.OCCUPIED || bookings.all.length > 0)) {
      throw conflict("ROOM_IN_USE", `Room ${room.roomNumber} is occupied or has reservations assigned (${codes(bookings.all)}). Reassign them first.`);
    }
    if (typeChanging && bookings.all.length > 0) {
      throw conflict("ROOM_IN_USE", "The room type cannot change while reservations are assigned to this room.");
    }
    if (changes.capacity !== undefined && bookings.all.some((r) => r.numGuests > changes.capacity)) {
      throw conflict("ROOM_IN_USE", "A reservation assigned to this room has more guests than the new capacity.");
    }
    // Reservations booked by type (not yet assigned) still need enough rooms of the type.
    if (room.isActive && (deactivating || typeChanging)) {
      await assertRoomRemovable(room, {}, transaction);
    } else if (room.isActive && statusChanging && changes.status === ROOM_STATUS.MAINTENANCE) {
      await assertRoomRemovable(room, { tonightOnly: true }, transaction);
    }

    const update = {};
    for (const key of [...ROOM_FIELDS, "isActive"]) if (changes[key] !== undefined) update[key] = changes[key];
    if (statusChanging) update.status = changes.status;
    await guardUniqueNumber(() => room.update(update, { transaction }));
    logger.info("room_updated", { roomId: room.id, fields: Object.keys(update), by: actor?.id });
    return {
      ...roomJSON(room),
      // Future guests still assigned to a room that is under maintenance (shown as a warning).
      upcomingReservations: room.status === ROOM_STATUS.MAINTENANCE ? bookings.all.length : 0,
    };
  });
}

/**
 * Deletes a room.
 *  - Refused while the room is occupied or holds any active reservation, or
 *    when the remaining rooms of its type could not honour existing bookings.
 *  - A room that was never booked is deleted permanently.
 *  - A room with past reservations is archived instead (soft delete): it
 *    leaves inventory and every list, while its reservations, stays, bills and
 *    receipts keep pointing at it. Its number stays reserved so history
 *    remains unambiguous; it can be restored.
 */
export async function deleteRoom(id, actor) {
  return withTransaction(null, async (transaction) => {
    const room = await lockRoom(id, transaction);
    if (room.archivedAt) throw notFound("Room");
    if (room.status === ROOM_STATUS.OCCUPIED) {
      throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is occupied by an in-house guest and cannot be deleted.`);
    }
    const bookings = await assignedBookings(room, transaction);
    if (bookings.all.length) {
      throw conflict(
        "ROOM_HAS_ACTIVE_RESERVATIONS",
        `Room ${room.roomNumber} has ${bookings.all.length} active reservation(s) (${codes(bookings.all)}). Reassign or cancel them first.`
      );
    }
    if (room.isActive) await assertRoomRemovable(room, {}, transaction);

    const history = await Reservation.count({ where: { roomId: room.id }, transaction });
    if (history === 0) {
      await room.destroy({ transaction });
      logger.info("room_deleted", { roomId: room.id, roomNumber: room.roomNumber, by: actor?.id });
      return { mode: "deleted", room: roomJSON(room) };
    }
    await room.update({ isActive: false, archivedAt: new Date() }, { transaction });
    logger.info("room_archived", { roomId: room.id, roomNumber: room.roomNumber, historicalReservations: history, by: actor?.id });
    return { mode: "archived", historicalReservations: history, room: roomJSON(room) };
  });
}

/** Brings an archived ("deleted") room back into service. */
export async function restoreRoom(id, actor) {
  const room = await Room.findByPk(id);
  if (!room || !room.archivedAt) throw notFound("Deleted room");
  await room.update({ archivedAt: null, isActive: true });
  logger.info("room_restored", { roomId: room.id, by: actor?.id });
  return roomJSON(room);
}

/** RoomStatusUpdater.setOccupied — called inside the check-in transaction. */
export async function setOccupied(roomId, transaction) {
  const [count] = await Room.update(
    { status: ROOM_STATUS.OCCUPIED },
    { where: { id: roomId, status: ROOM_STATUS.VACANT }, transaction }
  );
  if (count !== 1) throw conflict("ROOM_OCCUPIED", "The room is already occupied or under maintenance.");
}

/**
 * RoomStatusUpdater.setVacant — called inside the checkout / room-move
 * transaction. The room is flagged for housekeeping at the same time.
 */
export async function setVacant(roomId, transaction) {
  await Room.update({ status: ROOM_STATUS.VACANT, needsCleaning: true }, { where: { id: roomId }, transaction });
}

/** Housekeeping: mark a room as cleaned / ready for the next guest. */
export async function markClean(roomId, actor) {
  const room = await Room.findByPk(roomId);
  if (!room) throw notFound("Room");
  if (!room.needsCleaning) throw conflict("ALREADY_CLEAN", `Room ${room.roomNumber} is already marked clean.`);
  await room.update({ needsCleaning: false, lastCleanedAt: new Date(), lastCleanedBy: actor.id });
  logger.info("room_cleaned", { roomId: room.id, by: actor.id });
  return roomJSON(room);
}
