/**
 * Housekeeping System endpoints — mounted at /api/v1/integrations/housekeeping
 * Auth: HOUSEKEEPING_API_KEY. Writes require an Idempotency-Key header and,
 * when HOUSEKEEPING_INBOUND_SECRET is set, an HMAC signature (X-Timestamp + X-Signature).
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
