/**
 * Housekeeping System (Member 3) ⇄ PMS.
 *
 *   PMS → Housekeeping   RoomVacated (webhook) when a guest checks out or moves rooms; the room is DIRTY.
 *   Housekeeping → PMS   cleaning-tasks      (optional) "task HK-… created for room 201"  — room stays DIRTY
 *                        cleaning-started    DIRTY → CLEANING
 *                        cleaning-completed  CLEANING (or DIRTY) → AVAILABLE, or RESERVED when a confirmed
 *                                            reservation is assigned; RoomCleaned is published.
 *
 * The PMS keeps only a reference to each task (housekeeping_tasks) — staff,
 * schedules and progress belong to the Housekeeping System. external_task_id
 * is unique, so the same completion can never be applied twice, and every
 * change runs under a row lock on the room.
 */
import { Op, UniqueConstraintError } from "sequelize";
import {
  Room,
  HousekeepingTask,
  IntegrationEvent,
  ROOM_STATUS,
  HOUSEKEEPING_ROOM_STATUSES,
  HOUSEKEEPING_TASK_STATUS,
  STATUS_CHANGE_SOURCE,
} from "../../models/index.js";
import { AppError, conflict, validationError } from "../../utils/errors.js";
import { withTransaction } from "../../services/tx.js";
import { transition, makeReadyAfterCleaning, STATUS_REASON } from "../../services/roomStatusService.js";
import { emit, EVENTS } from "../../services/domainEvents.js";
import { roomCleanedData } from "../../services/eventPayloads.js";
import { logger } from "../../utils/logger.js";

const T = HOUSEKEEPING_TASK_STATUS;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const taskView = (task, room) => ({
  external_task_id: task.externalTaskId,
  task_status: task.status,
  room_id: task.roomId,
  room_number: room?.roomNumber ?? null,
  room_status: room?.status ?? null,
  stay_id: task.stayId ?? null,
  source_event_id: task.sourceEventId ?? null,
  started_at: task.startedAt ?? null,
  started_by: task.startedBy ?? null,
  completed_at: task.completedAt ?? null,
  completed_by: task.completedBy ?? null,
  remarks: task.remarks ?? null,
  recorded_at: task.updatedAt,
});

const roomView = (room, openTask) => ({
  room_id: room.id,
  room_number: room.roomNumber,
  room_type: room.roomType,
  floor: room.floor,
  status: room.status,
  status_changed_at: room.statusChangedAt,
  last_cleaned_at: room.lastCleanedAt,
  open_task: openTask ? { external_task_id: openTask.externalTaskId, task_status: openTask.status, started_at: openTask.startedAt } : null,
});

const OPEN = [T.OPEN, T.IN_PROGRESS];

export async function listRooms({ status } = {}) {
  const where = { isActive: true, archivedAt: null };
  if (status) where.status = status;
  const rooms = await Room.findAll({ where, order: [["roomNumber", "ASC"]] });
  const tasks = rooms.length ? await HousekeepingTask.findAll({ where: { roomId: rooms.map((r) => r.id), status: OPEN } }) : [];
  const byRoom = new Map(tasks.map((t) => [t.roomId, t]));
  return rooms.map((r) => roomView(r, byRoom.get(r.id)));
}

export async function getRoomByNumber(roomNumber) {
  const room = await Room.findOne({ where: { roomNumber, archivedAt: null } });
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", `Room ${roomNumber} does not exist.`);
  return roomView(room, await HousekeepingTask.findOne({ where: { roomId: room.id, status: OPEN } }));
}

/** Locks the room named by room_id and/or room_number; both must point at the same room. */
async function lockRoom({ room_id: id, room_number: number }, transaction) {
  if (!id && !number) throw validationError({ room_number: "Send room_id or room_number." });
  const room = await Room.findOne({ where: id ? { id } : { roomNumber: number }, transaction, lock: transaction.LOCK.UPDATE });
  if (!room || room.archivedAt) throw new AppError(404, "ROOM_NOT_FOUND", `Room ${number || id} does not exist.`);
  if (id && number && room.roomNumber !== number) {
    throw conflict("ROOM_MISMATCH", `room_id ${id} is room ${room.roomNumber}, not ${number}.`);
  }
  return room;
}

/** The RoomVacated event this task answers: the one named by event_id, or the room's latest. */
async function vacatedEvent(room, eventId, transaction) {
  if (eventId) {
    const event = await IntegrationEvent.findOne({ where: { eventId, eventType: EVENTS.ROOM_VACATED }, transaction });
    if (!event) throw validationError({ event_id: `No RoomVacated event ${eventId}.` });
    if (event.aggregateId !== room.id) throw conflict("EVENT_ROOM_MISMATCH", `Event ${eventId} is for another room.`);
    return event;
  }
  return IntegrationEvent.findOne({
    where: { eventType: EVENTS.ROOM_VACATED, aggregateType: "ROOM", aggregateId: room.id },
    order: [["id", "DESC"]],
    transaction,
  });
}

const findTask = (externalTaskId, transaction) =>
  HousekeepingTask.findOne({ where: { externalTaskId }, transaction, lock: transaction.LOCK.UPDATE });

async function createTask(room, input, status, transaction) {
  const event = await vacatedEvent(room, input.event_id, transaction);
  return HousekeepingTask.create(
    {
      externalTaskId: input.external_task_id,
      roomId: room.id,
      stayId: event?.payload?.stay_id ?? null,
      sourceEventId: event?.eventId ?? null,
      status,
      remarks: input.remarks ?? null,
    },
    { transaction }
  );
}

const assertTaskForRoom = (task, room) => {
  if (task && task.roomId !== room.id) {
    throw conflict("TASK_ROOM_MISMATCH", `Task ${task.externalTaskId} belongs to another room.`);
  }
};

const assertAwaitingCleaning = (room) => {
  if (!HOUSEKEEPING_ROOM_STATUSES.includes(room.status)) {
    throw conflict("ROOM_NOT_AWAITING_CLEANING", `Room ${room.roomNumber} is ${room.status}; it is not waiting for cleaning.`, {
      room_status: room.status,
    });
  }
};

const assertNotFuture = (field, date) => {
  if (date && date > new Date(Date.now() + CLOCK_SKEW_MS)) throw validationError({ [field]: "Cannot be in the future." });
};

/** Runs fn in a transaction; a concurrent insert of the same external_task_id becomes 409. */
const guarded = async (fn) => {
  try {
    return await withTransaction(null, fn);
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw conflict("DUPLICATE_TASK", "This external_task_id was already registered.");
    throw err;
  }
};

/** CleaningTaskCreated: links the external task to the room. The room stays DIRTY. */
export async function registerTask(input) {
  return guarded(async (t) => {
    const room = await lockRoom(input, t);
    const existing = await findTask(input.external_task_id, t);
    if (existing) throw conflict("DUPLICATE_TASK", "This external_task_id was already registered.", taskView(existing, room));
    assertAwaitingCleaning(room);
    const task = await createTask(room, input, T.OPEN, t);
    await emit(EVENTS.CLEANING_TASK_CREATED, { origin: "HOUSEKEEPING", room_id: room.id, room_number: room.roomNumber, external_task_id: task.externalTaskId }, { transaction: t });
    return taskView(task, room);
  });
}

/** CleaningStarted: DIRTY → CLEANING. */
export async function cleaningStarted(input) {
  assertNotFuture("started_at", input.started_at);
  return guarded(async (t) => {
    const room = await lockRoom(input, t);
    let task = await findTask(input.external_task_id, t);
    assertTaskForRoom(task, room);
    if (task && task.status !== T.OPEN) {
      throw conflict("TASK_ALREADY_STARTED", `Task ${task.externalTaskId} is already ${task.status}.`, taskView(task, room));
    }
    if (room.status !== ROOM_STATUS.DIRTY) {
      throw conflict("ROOM_NOT_AWAITING_CLEANING", `Room ${room.roomNumber} is ${room.status}; cleaning can only start on a DIRTY room.`, {
        room_status: room.status,
      });
    }
    task ??= await createTask(room, input, T.OPEN, t);
    await transition(
      room,
      ROOM_STATUS.CLEANING,
      { reason: STATUS_REASON.CLEANING_STARTED, source: STATUS_CHANGE_SOURCE.HOUSEKEEPING, reference: task.externalTaskId },
      t
    );
    await task.update(
      { status: T.IN_PROGRESS, startedAt: input.started_at || new Date(), startedBy: input.started_by, ...(input.remarks ? { remarks: input.remarks } : {}) },
      { transaction: t }
    );
    await emit(
      EVENTS.CLEANING_STARTED,
      { origin: "HOUSEKEEPING", room_id: room.id, room_number: room.roomNumber, external_task_id: task.externalTaskId, started_by: task.startedBy, started_at: task.startedAt },
      { transaction: t }
    );
    logger.info("housekeeping_cleaning_started", { roomId: room.id, task: task.externalTaskId });
    return taskView(task, room);
  });
}

/**
 * CleaningCompleted: the room becomes ready (AVAILABLE / RESERVED) and
 * RoomCleaned is published. Refused when the room is not DIRTY / CLEANING,
 * when the task belongs to another room, or when this task was already
 * completed (duplicate delivery).
 */
export async function cleaningCompleted(input) {
  assertNotFuture("completed_at", input.completed_at);
  return guarded(async (t) => {
    const room = await lockRoom(input, t);
    let task = await findTask(input.external_task_id, t);
    if (task?.status === T.COMPLETED) {
      throw conflict("DUPLICATE_CLEANING_COMPLETION", `Task ${task.externalTaskId} was already completed.`, taskView(task, await Room.findByPk(task.roomId, { transaction: t })));
    }
    assertTaskForRoom(task, room);
    if (task?.status === T.SUPERSEDED) {
      throw conflict("TASK_SUPERSEDED", `Room ${room.roomNumber} was already marked clean at the front desk.`, taskView(task, room));
    }
    assertAwaitingCleaning(room);
    if (task?.startedAt && input.completed_at < task.startedAt) {
      throw validationError({ completed_at: "Cannot be earlier than the time cleaning started." });
    }

    const previousStatus = room.status;
    task ??= await createTask(room, input, T.OPEN, t);
    await makeReadyAfterCleaning(
      room,
      { reason: STATUS_REASON.CLEANING_COMPLETED, source: STATUS_CHANGE_SOURCE.HOUSEKEEPING, reference: task.externalTaskId },
      t
    );
    await room.update({ lastCleanedAt: input.completed_at, lastCleanedBy: null }, { transaction: t });
    await task.update(
      { status: T.COMPLETED, completedAt: input.completed_at, completedBy: input.completed_by, ...(input.remarks ? { remarks: input.remarks } : {}) },
      { transaction: t }
    );
    // Any other task still open for this room is answered by this cleaning too.
    await HousekeepingTask.update(
      { status: T.SUPERSEDED },
      { where: { roomId: room.id, status: OPEN, id: { [Op.ne]: task.id } }, transaction: t }
    );

    const common = { room_id: room.id, room_number: room.roomNumber, external_task_id: task.externalTaskId };
    await emit(EVENTS.CLEANING_COMPLETED, { origin: "HOUSEKEEPING", ...common, completed_by: task.completedBy, completed_at: task.completedAt }, { transaction: t });
    await emit(
      EVENTS.ROOM_CLEANED,
      roomCleanedData(room, { externalTaskId: task.externalTaskId, completedBy: task.completedBy, completedAt: task.completedAt, origin: "HOUSEKEEPING" }),
      { transaction: t }
    );
    logger.info("housekeeping_cleaning_completed", { roomId: room.id, task: task.externalTaskId, from: previousStatus, to: room.status });
    return { ...taskView(task, room), previous_room_status: previousStatus };
  });
}
