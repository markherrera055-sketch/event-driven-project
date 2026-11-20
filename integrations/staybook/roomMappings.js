/**
 * StayBook room id ↔ PMS room mapping, maintained by an administrator
 * (Admin Console → Integrations, staff API /api/v1/admin/staybook/room-mappings).
 *
 * Changing or removing a mapping never touches existing reservations: they
 * keep pointing at their PMS room. It only affects how FUTURE StayBook
 * requests are translated.
 */
import { UniqueConstraintError } from "sequelize";
import { sequelize, Room, ExternalRoomMapping, EXTERNAL_SYSTEMS } from "../../models/index.js";
import { conflict, notFound, validationError } from "../../utils/errors.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

const SYSTEM = EXTERNAL_SYSTEMS.STAYBOOK;
const STAYBOOK_ROOM_ID = /^[A-Za-z0-9._:-]{1,50}$/;

const assertStaybookRoomId = (id) => {
  if (!STAYBOOK_ROOM_ID.test(String(id))) throw validationError({ staybookRoomId: "Use 1-50 letters, digits, . _ : -" });
  return String(id);
};

/** Every PMS room (except deleted ones) with its StayBook room id, if mapped. */
export async function listRoomMappings() {
  const [rooms, mappings] = await Promise.all([
    Room.findAll({ where: { archivedAt: null }, attributes: ["id", "roomNumber", "roomType", "isActive", "status"] }),
    ExternalRoomMapping.findAll({ where: { sourceSystem: SYSTEM }, include: [{ association: "room", attributes: ["id", "roomNumber", "archivedAt"] }] }),
  ]);
  const byRoom = new Map(mappings.map((m) => [m.roomId, m]));
  return {
    hotelId: config.integrations.staybook.hotelId,
    rooms: rooms
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }))
      .map((r) => ({
        roomId: r.id,
        roomNumber: r.roomNumber,
        roomType: r.roomType,
        isActive: r.isActive,
        staybookRoomId: byRoom.get(r.id)?.externalRoomId ?? null,
        mappedAt: byRoom.get(r.id)?.updatedAt ?? null,
      })),
    // Mappings that point at a room which has since been deleted (archived).
    orphaned: mappings.filter((m) => m.room?.archivedAt).map((m) => ({ staybookRoomId: m.externalRoomId, roomId: m.roomId, roomNumber: m.room.roomNumber })),
  };
}

/**
 * Creates or moves the mapping of one StayBook room. When the PMS room is
 * already mapped to another StayBook id, `replace` swaps it in one
 * transaction; without it the request is refused (409 ROOM_ALREADY_MAPPED).
 */
export async function setRoomMapping(staybookRoomId, roomId, actor, { replace = false } = {}) {
  const externalRoomId = assertStaybookRoomId(staybookRoomId);
  const room = await Room.findByPk(roomId, { attributes: ["id", "roomNumber", "archivedAt"] });
  if (!room || room.archivedAt) throw notFound("Room");
  try {
    await sequelize.transaction(async (transaction) => {
      const taken = await ExternalRoomMapping.findOne({ where: { sourceSystem: SYSTEM, roomId }, transaction, lock: transaction.LOCK.UPDATE });
      if (taken && taken.externalRoomId !== externalRoomId) {
        if (!replace) {
          throw conflict("ROOM_ALREADY_MAPPED", `Room ${room.roomNumber} is already mapped to StayBook room ${taken.externalRoomId}. Remove that mapping first.`);
        }
        await taken.destroy({ transaction });
      }
      const existing = await ExternalRoomMapping.findOne({ where: { sourceSystem: SYSTEM, externalRoomId }, transaction, lock: transaction.LOCK.UPDATE });
      if (existing) await existing.update({ roomId, createdBy: actor?.id ?? null }, { transaction });
      else await ExternalRoomMapping.create({ sourceSystem: SYSTEM, externalRoomId, roomId, createdBy: actor?.id ?? null }, { transaction });
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw conflict("ROOM_ALREADY_MAPPED", "This room or StayBook room was mapped by someone else. Reload and try again.");
    throw err;
  }
  logger.info("staybook_room_mapped", { staybookRoomId: externalRoomId, roomId, by: actor?.id });
  return { staybookRoomId: externalRoomId, roomId, roomNumber: room.roomNumber };
}

export async function deleteRoomMapping(staybookRoomId, actor) {
  const externalRoomId = assertStaybookRoomId(staybookRoomId);
  const removed = await ExternalRoomMapping.destroy({ where: { sourceSystem: SYSTEM, externalRoomId } });
  if (!removed) throw notFound("Room mapping");
  logger.info("staybook_room_unmapped", { staybookRoomId: externalRoomId, by: actor?.id });
  return { staybookRoomId: externalRoomId, removed: true };
}

export const mappedRoomCount = () => ExternalRoomMapping.count({ where: { sourceSystem: SYSTEM } });
