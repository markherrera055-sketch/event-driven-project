/**
 * HR and Payroll System endpoints — mounted at /api/v1/integrations/hr
 * Auth: HR_API_KEY. Read-only.
 *
 * Architecture decision: housekeeping job logs go DIRECTLY from the
 * Housekeeping System to HR/Payroll (the PMS does not relay them). Housekeeping
 * owns the employee, start time and duration data; relaying it through the PMS
 * would duplicate that data and couple the PMS to HR's schema. What the PMS can
 * contribute is an independent record of each cleaning it accepted, so HR can
 * verify a job log against it before crediting work. Completion of a task is
 * NOT attendance or approved overtime — HR applies its own rules.
 */
import express from "express";
import { Op } from "sequelize";
import { asyncHandler, ok } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { AppError, validationError } from "../../utils/errors.js";
import { HousekeepingTask, HOUSEKEEPING_TASK_STATUS } from "../../models/index.js";
import { config } from "../../config/index.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";

const router = express.Router();
router.use(requireScope(SCOPES.HOUSEKEEPING_TASKS_READ));

const MAX_RANGE_DAYS = 31;

const hrView = (task) => ({
  external_task_id: task.externalTaskId,
  task_status: task.status,
  room_id: task.roomId,
  room_number: task.room?.roomNumber ?? null,
  started_at: task.startedAt,
  started_by: task.startedBy,
  completed_at: task.completedAt,
  completed_by: task.completedBy,
  // Duration as recorded by the PMS from Housekeeping's own timestamps (null when the start was not reported).
  duration_minutes: task.startedAt && task.completedAt ? Math.round((new Date(task.completedAt) - new Date(task.startedAt)) / 60000) : null,
  remarks: task.remarks,
  recorded_at: task.updatedAt,
});

const dayStart = (iso) => new Date(`${iso}T00:00:00${config.hotel.utcOffset}`);

router.get(
  "/housekeeping-tasks",
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      from: v.date({ required: true }),
      to: v.date({ required: true }),
      employee_id: v.string({ max: 60 }),
      status: v.enum(Object.values(HOUSEKEEPING_TASK_STATUS)),
    });
    if (q.to < q.from) throw validationError({ to: "Must be on or after from." });
    const days = (dayStart(q.to) - dayStart(q.from)) / 86400000;
    if (days > MAX_RANGE_DAYS) throw validationError({ to: `The range can be at most ${MAX_RANGE_DAYS} days.` });

    const where = {
      status: q.status || HOUSEKEEPING_TASK_STATUS.COMPLETED,
      completedAt: { [Op.gte]: dayStart(q.from), [Op.lt]: new Date(dayStart(q.to).getTime() + 86400000) },
    };
    if (q.status && q.status !== HOUSEKEEPING_TASK_STATUS.COMPLETED) delete where.completedAt;
    if (q.employee_id) where[Op.or] = [{ completedBy: q.employee_id }, { startedBy: q.employee_id }];
    const tasks = await HousekeepingTask.findAll({ where, include: ["room"], order: [["completedAt", "ASC"], ["id", "ASC"]], limit: 1000 });
    ok(res, tasks.map(hrView), { from: q.from, to: q.to, count: tasks.length });
  })
);

router.get(
  "/housekeeping-tasks/:externalTaskId",
  asyncHandler(async (req, res) => {
    const task = await HousekeepingTask.findOne({ where: { externalTaskId: req.params.externalTaskId }, include: ["room"] });
    if (!task) throw new AppError(404, "TASK_NOT_FOUND", `The PMS has no record of housekeeping task ${req.params.externalTaskId}.`);
    ok(res, hrView(task));
  })
);

export default router;
