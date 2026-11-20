/**
 * Restaurant charges — staff review of purchase notifications from the
 * external Restaurant POS. Reading is open to all staff; approving, rejecting
 * and resolving voids is a billing action (receptionists, see routes/api/v1.js).
 */
import { asyncHandler, ok, pagination } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { POS_ORDER_STATUS } from "../../models/index.js";
import * as review from "../../services/posOrderReviewService.js";

export const list = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    status: v.enum([...Object.values(POS_ORDER_STATUS), "OPEN"]),
    search: v.string({ max: 100 }),
    reservationId: v.int({ min: 1 }),
    needsAdjustment: v.bool(),
  });
  const result = await review.listPosOrders({ ...q, ...pagination(req.query) });
  ok(res, result.data, result.meta);
});

export const summary = asyncHandler(async (req, res) => ok(res, await review.posOrderSummary()));

export const show = asyncHandler(async (req, res) => ok(res, await review.getPosOrder(Number(req.params.id))));

export const approve = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    stayId: v.int({ required: true, min: 1 }),
    note: v.string({ min: 3, max: 255 }),
  });
  ok(res, await review.approvePosOrder(Number(req.params.id), input, req.user));
});

export const reject = asyncHandler(async (req, res) => {
  const { reason } = validate(req.body, { reason: v.string({ required: true, min: 3, max: 255 }) });
  ok(res, await review.rejectPosOrder(Number(req.params.id), { reason }, req.user));
});

export const resolveVoid = asyncHandler(async (req, res) => ok(res, await review.resolveVoidedPosOrder(Number(req.params.id), req.user)));
