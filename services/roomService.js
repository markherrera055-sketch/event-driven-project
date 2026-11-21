/**
 * Rooms: listing, room types, and the room part of the Room and Staff Admin
 * module (Administrator.manageRooms). Status changes go through
 * roomStatusService (the lifecycle state machine), never directly.
 *
 * Administrator status rules:
 *   → MAINTENANCE   from any status except OCCUPIED; not while a guest is due in tonight.
 *                   A DIRTY / CLEANING room keeps its cleaning requirement while under maintenance.
 *   MAINTENANCE →   AVAILABLE ("ready": RESERVED if a confirmed reservation is assigned) — refused with
 *                   ROOM_NEEDS_CLEANING while cleaning is pending (roomStatusService cleaning guard) —
 *                   or DIRTY (needs cleaning)
 *   isActive true ⇄ false  (Inactive = out of inventory)
 * displayStatus = the stored status, or INACTIVE / DELETED for rooms out of inventory.
 *
 * Catalogue changes (create, edit, delete/archive, restore) publish RoomCreated /
 * RoomUpdated / RoomArchived / RoomRestored inside the same transaction; the
 * integration layer turns them into room sync jobs for OnlineBooking and RoomCare
 * (integrations/roomSync). A room that is known to an external system (mapped, or
 * already sent) is archived instead of deleted, so its external records stay valid.
 */
import { Op, fn, col, UniqueConstraintError } from "sequelize";
import {
  Room,
  RoomType,
  Reservation,
  HousekeepingTask,
  ExternalRoomMapping,
  RoomSyncJob,
  ROOM_STATUS,
  READY_ROOM_STATUSES,
  HOUSEKEEPING_ROOM_STATUSES,
  ACTIVE_RESERVATION_STATUSES,
  RESERVATION_STATUS,
  STATUS_CHANGE_SOURCE,
  HOUSEKEEPING_TASK_STATUS,
} from "../models/index.js";
import { conflict, notFound } from "../utils/errors.js";
import { today } from "../utils/dates.js";
import { assertRoomRemovable, lockRoomTypes, peekRoomType } from "./availabilityService.js";
import { transition, readyStatusFor, lockRoomRow, finishCleaning, pendingCleaning, STATUS_REASON } from "./roomStatusService.js";
import { emit, EVENTS } from "./domainEvents.js";
import { roomCleanedData, roomCatalogData } from "./eventPayloads.js";
import { roomJSON } from "./serializers.js";
import { withTransaction } from "./tx.js";
import { logger } from "../utils/logger.js";

export const DISPLAY_STATUS = Object.freeze({ ...ROOM_STATUS, INACTIVE: "INACTIVE", DELETED: "DELETED" });

const displayStatusOf = (room) => {
  if (room.archivedAt) return DISPLAY_STATUS.DELETED;
  if (!room.isActive) return DISPLAY_STATUS.INACTIVE;
  return room.status;
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
  if (needsCleaning !== undefined && !status) {
    where.status = needsCleaning ? { [Op.in]: HOUSEKEEPING_ROOM_STATUSES } : { [Op.notIn]: HOUSEKEEPING_ROOM_STATUSES };
  }
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

  // Confirmed reservations arriving into a room tonight (shown on the room board).
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
      displayStatus: displayStatusOf(r),
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
  const ids = new Map((await RoomType.findAll({ where: { name: rows.map((r) => r.roomType) }, attributes: ["id", "name"] })).map((t) => [t.name.toLowerCase(), t.id]));
  return rows.map((r) => ({
    roomTypeId: ids.get(r.roomType.toLowerCase()) ?? null,
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

/** Catalogue fields whose requested value differs from the stored one. */
const SAME = {
  nightlyRate: (a, b) => Number(a) === Number(b),
  amenities: (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []),
};
const equalValues = (a, b) => (a ?? null) === (b ?? null);
const changedFields = (room, update) => Object.keys(update).filter((key) => !(SAME[key] || equalValues)(room.get(key), update[key]));

export async function createRoom(data, actor) {
  await assertNumberFree(data.roomNumber);
  const values = {
    status: data.status === ROOM_STATUS.MAINTENANCE ? ROOM_STATUS.MAINTENANCE : ROOM_STATUS.AVAILABLE,
    statusChangedAt: new Date(),
  };
  for (const key of ROOM_FIELDS) if (data[key] !== undefined) values[key] = data[key];
  if (data.isActive !== undefined) values.isActive = data.isActive;
  const room = await guardUniqueNumber(() =>
    withTransaction(null, async (transaction) => {
      const created = await Room.create(values, { transaction });
      await emit(EVENTS.ROOM_CREATED, roomCatalogData(created, { changes: Object.keys(values), actor }), { transaction });
      return created;
    })
  );
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

/**
 * Status requested by an administrator → status to transition to, or null for
 * "no change". AVAILABLE means "ready for guests" (RESERVED when a confirmed
 * reservation is assigned); DIRTY means "needs cleaning" (already true while
 * the room is DIRTY or CLEANING). Requests the lifecycle does not allow (e.g.
 * marking a DIRTY room ready, which is housekeeping's job) are refused.
 */
async function adminTargetStatus(room, requested, transaction) {
  if (!requested) return null;
  if (requested === ROOM_STATUS.AVAILABLE) {
    if (READY_ROOM_STATUSES.includes(room.status)) return null;
    if (HOUSEKEEPING_ROOM_STATUSES.includes(room.status)) {
      throw conflict("ROOM_NEEDS_CLEANING", `Room ${room.roomNumber} is ${room.status}. It becomes available when housekeeping completes cleaning (or use "Mark clean").`);
    }
    if (room.status === ROOM_STATUS.OCCUPIED) return ROOM_STATUS.AVAILABLE; // refused by the OCCUPIED rule
    return readyStatusFor(room.id, transaction);
  }
  if (requested === ROOM_STATUS.DIRTY && HOUSEKEEPING_ROOM_STATUSES.includes(room.status)) return null;
  return requested === room.status ? null : requested;
}

export async function updateRoom(id, changes, actor) {
  return withTransaction(null, async (transaction) => {
    const room = await lockRoom(id, transaction);
    if (room.archivedAt) throw notFound("Room");

    if (changes.roomNumber && changes.roomNumber !== room.roomNumber) await assertNumberFree(changes.roomNumber, transaction);

    const bookings = await assignedBookings(room, transaction);
    const deactivating = changes.isActive === false && room.isActive;
    const typeChanging = !!changes.roomType && changes.roomType !== room.roomType;
    const targetStatus = await adminTargetStatus(room, changes.status, transaction);
    const statusChanging = !!targetStatus;

    // OCCUPIED is controlled by check-in / checkout / room move only.
    if (statusChanging && room.status === ROOM_STATUS.OCCUPIED) {
      throw conflict("ROOM_OCCUPIED", `Room ${room.roomNumber} is occupied. Its status changes automatically at checkout or room move.`);
    }
    if (statusChanging && targetStatus === ROOM_STATUS.MAINTENANCE && bookings.tonight.length) {
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
    } else if (room.isActive && statusChanging && targetStatus === ROOM_STATUS.MAINTENANCE) {
      await assertRoomRemovable(room, { tonightOnly: true }, transaction);
    }

    const update = {};
    for (const key of [...ROOM_FIELDS, "isActive"]) if (changes[key] !== undefined) update[key] = changes[key];
    const changed = changedFields(room, update);
    await guardUniqueNumber(() => room.update(update, { transaction }));
    if (statusChanging) {
      const reason = targetStatus === ROOM_STATUS.MAINTENANCE ? STATUS_REASON.MAINTENANCE_STARTED : STATUS_REASON.MAINTENANCE_ENDED;
      await transition(room, targetStatus, { reason, source: STATUS_CHANGE_SOURCE.ADMIN, actor }, transaction);
      changed.push("status");
    }
    if (changed.length) await emit(EVENTS.ROOM_UPDATED, roomCatalogData(room, { changes: changed, actor }), { transaction });
    logger.info("room_updated", { roomId: room.id, fields: Object.keys(update), status: targetStatus || undefined, by: actor?.id });
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
 *  - A room that was never booked, and never sent to an external system, is
 *    deleted permanently (room sync jobs that were never attempted go with it).
 *  - A room with past reservations, or one known to OnlineBooking / RoomCare
 *    (mapped, or already sent), is archived instead (soft delete): it
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
    const [mapped, sent] = await Promise.all([
      ExternalRoomMapping.count({ where: { roomId: room.id }, transaction }),
      RoomSyncJob.count({ where: { roomId: room.id, lastAttemptAt: { [Op.ne]: null } }, transaction }),
    ]);
    if (history === 0 && mapped === 0 && sent === 0) {
      await RoomSyncJob.destroy({ where: { roomId: room.id }, transaction });
      await room.destroy({ transaction });
      logger.info("room_deleted", { roomId: room.id, roomNumber: room.roomNumber, by: actor?.id });
      return { mode: "deleted", room: roomJSON(room) };
    }
    await room.update({ isActive: false, archivedAt: new Date() }, { transaction });
    await emit(EVENTS.ROOM_ARCHIVED, roomCatalogData(room, { changes: ["archivedAt", "isActive"], actor }), { transaction });
    logger.info("room_archived", { roomId: room.id, roomNumber: room.roomNumber, historicalReservations: history, externalSystems: mapped, by: actor?.id });
    return { mode: "archived", historicalReservations: history, externalSystems: mapped, room: roomJSON(room) };
  });
}

/** Brings an archived ("deleted") room back into service. */
export async function restoreRoom(id, actor) {
  const room = await withTransaction(null, async (transaction) => {
    const found = await Room.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!found || !found.archivedAt) throw notFound("Deleted room");
    await found.update({ archivedAt: null, isActive: true }, { transaction });
    await emit(EVENTS.ROOM_RESTORED, roomCatalogData(found, { changes: ["archivedAt", "isActive"], actor }), { transaction });
    return found;
  });
  logger.info("room_restored", { roomId: room.id, by: actor?.id });
  return roomJSON(room);
}

/**
 * Front-desk fallback for when the Housekeeping System cannot report back:
 * DIRTY / CLEANING → ready. A room under MAINTENANCE that still needs cleaning
 * stays under maintenance; only its cleaning requirement is cleared. Any open
 * housekeeping task for the room is marked SUPERSEDED (this explicit staff
 * action is the verification), and RoomCleaned is published so Housekeeping
 * can close its task.
 */
export async function markClean(roomId, actor) {
  await withTransaction(null, async (transaction) => {
    const room = await lockRoomRow(roomId, transaction);
    const awaiting =
      HOUSEKEEPING_ROOM_STATUSES.includes(room.status) || (room.status === ROOM_STATUS.MAINTENANCE && (await pendingCleaning(room, transaction)).required);
    if (!awaiting) {
      throw conflict("ALREADY_CLEAN", `Room ${room.roomNumber} does not need cleaning (status ${room.status}).`);
    }
    const now = new Date();
    await finishCleaning(room, { reason: STATUS_REASON.MANUAL_CLEAN, source: STATUS_CHANGE_SOURCE.FRONT_DESK, actor }, transaction);
    await room.update({ lastCleanedAt: now, lastCleanedBy: actor.id }, { transaction });
    await HousekeepingTask.update(
      { status: HOUSEKEEPING_TASK_STATUS.SUPERSEDED, remarks: `Marked clean at the front desk by ${actor.fullName || `user ${actor.id}`}` },
      { where: { roomId: room.id, status: [HOUSEKEEPING_TASK_STATUS.OPEN, HOUSEKEEPING_TASK_STATUS.IN_PROGRESS] }, transaction }
    );
    await emit(EVENTS.ROOM_CLEANED, roomCleanedData(room, { completedAt: now, origin: "FRONT_DESK" }), { transaction });
    logger.info("room_cleaned", { roomId: room.id, status: room.status, by: actor.id });
  });
  return getRoom(roomId);
}
