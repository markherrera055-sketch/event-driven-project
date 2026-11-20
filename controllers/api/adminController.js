/** Admin Console API (Administrator.manageRooms / manageStaffAccounts) + integration monitoring. */
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { notFound } from "../../utils/errors.js";
import { ROLES, OUTBOX_STATUS, IntegrationRequest, ADMIN_SETTABLE_ROOM_STATUSES } from "../../models/index.js";
import * as rooms from "../../services/roomService.js";
import * as staff from "../../services/staffService.js";
import { listOutbox, retryOutboxEvent, processOutbox } from "../../integrations/shared/outbox.js";
import { integrationStatus } from "../../integrations/index.js";
import * as staybookRooms from "../../integrations/staybook/roomMappings.js";

const roomSchema = {
  roomNumber: v.string({ required: true, max: 10, pattern: /^[A-Za-z0-9-]+$/, patternMessage: "Letters, digits and dashes only." }),
  roomType: v.string({ required: true, max: 50 }),
  floor: v.string({ max: 10, pattern: /^[A-Za-z0-9-]+$/, patternMessage: "Letters, digits and dashes only (e.g. 2, G, M)." }),
  capacity: v.int({ required: true, min: 1, max: 20 }),
  nightlyRate: v.money({ required: true, min: 0.01 }),
  description: v.string({ max: 1000 }),
  amenities: v.stringList({ maxItems: 30, itemMax: 40 }),
  // AVAILABLE ("ready"), DIRTY ("needs cleaning") and MAINTENANCE can be requested by hand;
  // the room status lifecycle decides whether the change is allowed (roomStatusService).
  status: v.enum(ADMIN_SETTABLE_ROOM_STATUSES),
  isActive: v.bool(),
};

export const createRoom = asyncHandler(async (req, res) => created(res, await rooms.createRoom(validate(req.body, roomSchema), req.user)));
export const updateRoom = asyncHandler(async (req, res) =>
  ok(res, await rooms.updateRoom(Number(req.params.id), validate(req.body, roomSchema, { partial: true }), req.user))
);
export const deleteRoom = asyncHandler(async (req, res) => ok(res, await rooms.deleteRoom(Number(req.params.id), req.user)));
export const restoreRoom = asyncHandler(async (req, res) => ok(res, await rooms.restoreRoom(Number(req.params.id), req.user)));

const usernameRule = (required) =>
  v.string({ required, min: 3, max: 50, lowercase: true, pattern: /^[a-z0-9._-]+$/, patternMessage: "Use lowercase letters, digits, . _ -" });

export const listStaff = asyncHandler(async (req, res) => {
  const q = validate(req.query, { search: v.string({ max: 100 }), role: v.enum(Object.values(ROLES)), isActive: v.bool() });
  ok(res, await staff.listStaff(q));
});

export const createStaff = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    fullName: v.string({ required: true, max: 120 }),
    username: usernameRule(true),
    password: v.password({ required: true }),
    role: v.enum(Object.values(ROLES), { required: true }),
  });
  created(res, await staff.createStaff(input, req.user));
});

export const updateStaff = asyncHandler(async (req, res) => {
  const changes = validate(
    req.body,
    {
      fullName: v.string({ required: true, max: 120 }),
      username: usernameRule(true),
      password: v.password(),
      role: v.enum(Object.values(ROLES), { required: true }),
      isActive: v.bool({ required: true }),
    },
    { partial: true }
  );
  ok(res, await staff.updateStaff(Number(req.params.id), changes, req.user));
});

/** Administrator-initiated reset: optional temporary password, otherwise one is generated and returned once. */
export const resetStaffPassword = asyncHandler(async (req, res) => {
  const { temporaryPassword } = validate(req.body, { temporaryPassword: v.password() });
  ok(res, await staff.resetStaffPassword(Number(req.params.id), { temporaryPassword }, req.user));
});

export const integrations = asyncHandler(async (req, res) => {
  const { status } = validate(req.query, { status: v.enum(Object.values(OUTBOX_STATUS)) });
  const [outbox, requests] = await Promise.all([
    listOutbox({ status, limit: 50 }),
    IntegrationRequest.findAll({
      attributes: ["id", "source", "idempotencyKey", "method", "path", "responseStatus", "createdAt"],
      order: [["id", "DESC"]],
      limit: 50,
    }),
  ]);
  ok(res, { status: integrationStatus(), outbox, requests });
});

/** StayBook room id ↔ Frontdesk room mapping (Admin Console → Integrations). */
export const staybookRoomMappings = asyncHandler(async (req, res) => ok(res, await staybookRooms.listRoomMappings()));
export const setStaybookRoomMapping = asyncHandler(async (req, res) => {
  const { roomId, replace } = validate(req.body, { roomId: v.int({ required: true, min: 1 }), replace: v.bool() });
  ok(res, await staybookRooms.setRoomMapping(req.params.staybookRoomId, roomId, req.user, { replace }));
});
export const deleteStaybookRoomMapping = asyncHandler(async (req, res) =>
  ok(res, await staybookRooms.deleteRoomMapping(req.params.staybookRoomId, req.user))
);

export const retryOutbox = asyncHandler(async (req, res) => {
  const row = await retryOutboxEvent(Number(req.params.id));
  if (!row) throw notFound("Outbox event");
  await processOutbox();
  ok(res, await row.reload());
});
