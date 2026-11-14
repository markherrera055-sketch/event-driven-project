/**
 * POS integration endpoints — mounted at /api/v1/integrations/pos
 * Auth: X-Api-Key = POS_API_KEY. Writes require an Idempotency-Key header.
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { CHARGE_CATEGORIES } from "../../models/index.js";
import * as pos from "./posService.js";

const router = express.Router();

const chargeSchema = {
  externalTransactionId: v.string({ required: true, max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" }),
  roomNumber: v.string({ required: true, max: 10 }),
  folioId: v.int({ min: 1 }),
  guestLastName: v.string({ max: 80 }),
  outlet: v.string({ max: 80 }),
  category: v.enum(CHARGE_CATEGORIES, { required: true }),
  description: v.string({ required: true, max: 255 }),
  amount: v.money({ required: true, min: 0.01 }),
  currency: v.string({ max: 3 }),
  transactionAt: v.datetime({ required: true }),
  items: v.array(
    {
      name: v.string({ required: true, max: 100 }),
      quantity: v.int({ required: true, min: 1, max: 1000 }),
      unitPrice: v.money({ required: true, min: 0 }),
    },
    { max: 100 }
  ),
};

router.get(
  "/in-house",
  asyncHandler(async (req, res) => {
    const { roomNumber } = validate(req.query, { roomNumber: v.string({ required: true, max: 10 }) });
    ok(res, await pos.lookupInHouse(roomNumber));
  })
);

router.post(
  "/charges",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, chargeSchema);
    created(res, await pos.postCharge(input));
  })
);

router.get(
  "/charges/:externalTransactionId",
  asyncHandler(async (req, res) => ok(res, await pos.getCharge(req.params.externalTransactionId)))
);

export default router;
