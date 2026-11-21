/**
 * Housekeeping System endpoints — mounted at /api/v1/integrations/housekeeping
 * Auth: HOUSEKEEPING_API_KEY. Writes require an Idempotency-Key header and an
 * HMAC signature (X-Timestamp + X-Signature) made with HOUSEKEEPING_INBOUND_SECRET.
 * Outside NODE_ENV=test a missing secret makes every write fail with 503
 * INBOUND_SIGNING_NOT_CONFIGURED (shared/auth.js); unsigned writes are never accepted.
 *
 * UNVERIFIED ASSUMPTION: RoomCare is treated as this Housekeeping System (Member 3)
 * and would use the same key, secret and endpoints. Member 3 has not confirmed
 * this; do not rename this integration or issue separate credentials until they do.
 *
 *   POST /cleaning-status   one callback for every task status change (intended for RoomCare):
 *     PENDING      task created, room stays DIRTY (VACANT_DIRTY)      = POST /cleaning-tasks
 *     IN_PROGRESS  DIRTY → CLEANING                                   = POST /cleaning-started
 *     COMPLETED    → AVAILABLE / RESERVED (VACANT_CLEAN), completion  = POST /cleaning-completed
 *                  time stored as the room's last cleaned time
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { ROOM_STATUS } from "../../models/index.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";
import * as hk from "./housekeepingService.js";

const router = express.Router();
const read = requireScope(SCOPES.ROOMS_READ);
const write = requireScope(SCOPES.HOUSEKEEPING_WRITE);

const taskRef = {
  external_task_id: v.string({ required: true, max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" }),
  room_id: v.int({ min: 1 }),
  room_number: v.string({ max: 10 }),
  event_id: v.string({ max: 30 }),
  remarks: v.string({ max: 500 }),
};
const employeeId = (required) => v.string({ required, max: 60 });

router.get(
  "/rooms",
  read,
  asyncHandler(async (req, res) => {
    const q = validate(req.query, { status: v.enum(Object.values(ROOM_STATUS)) });
    ok(res, await hk.listRooms(q));
  })
);

router.get("/rooms/:roomNumber", read, asyncHandler(async (req, res) => ok(res, await hk.getRoomByNumber(req.params.roomNumber))));

router.post(
  "/cleaning-tasks",
  write,
  asyncHandler(async (req, res) => created(res, await hk.registerTask(validate(req.body, { ...taskRef, assigned_to: employeeId(false) }))))
);

router.post(
  "/cleaning-started",
  write,
  asyncHandler(async (req, res) =>
    ok(res, await hk.cleaningStarted(validate(req.body, { ...taskRef, started_by: employeeId(true), started_at: v.datetime() })))
  )
);

const completedFields = { completed_by: employeeId(true), completed_at: v.datetime({ required: true }) };
const startedFields = { started_by: employeeId(true), started_at: v.datetime() };
export const CLEANING_STATUSES = Object.freeze(["PENDING", "IN_PROGRESS", "COMPLETED"]);

router.post(
  "/cleaning-status",
  write,
  asyncHandler(async (req, res) => {
    const { status } = validate(req.body, { status: v.enum(CLEANING_STATUSES, { required: true }) });
    if (status === "PENDING") {
      const task = await hk.registerTask(validate(req.body, { ...taskRef, assigned_to: employeeId(false) }));
      return created(res, { ...task, cleaning_status: status });
    }
    if (status === "IN_PROGRESS") {
      return ok(res, { ...(await hk.cleaningStarted(validate(req.body, { ...taskRef, ...startedFields }))), cleaning_status: status });
    }
    const input = validate(req.body, { ...taskRef, ...completedFields });
    return ok(res, { ...(await hk.cleaningCompleted({ ...input, status })), cleaning_status: status });
  })
);

router.post(
  "/cleaning-completed",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      ...taskRef,
      status: v.enum(["COMPLETED"], { required: true }),
      completed_by: employeeId(true),
      completed_at: v.datetime({ required: true }),
    });
    ok(res, await hk.cleaningCompleted(input));
  })
);

export default router;
