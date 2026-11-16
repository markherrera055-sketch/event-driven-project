/**
 * Restaurant POS endpoints — mounted at /api/v1/integrations/pos
 * Auth: POS_API_KEY. Writes require an Idempotency-Key header.
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { CHARGE_CATEGORIES } from "../../models/index.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";
import * as pos from "./posService.js";

const router = express.Router();

const chargeSchema = {
  external_transaction_id: v.string({ required: true, max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" }),
  reservation_id: v.int({ required: true, min: 1 }),
  room_number: v.string({ required: true, max: 10 }),
  guest_name: v.string({ max: 160 }),
  amount: v.money({ required: true, min: 0.01 }),
  currency: v.string({ required: true, min: 3, max: 3, pattern: /^[A-Za-z]{3}$/, patternMessage: "ISO 4217 code, e.g. PHP" }),
  description: v.string({ required: true, max: 255 }),
  category: v.enum(CHARGE_CATEGORIES),
  outlet: v.string({ max: 80 }),
  items: v.array(
    {
      name: v.string({ required: true, max: 100 }),
      quantity: v.int({ required: true, min: 1, max: 1000 }),
      unit_price: v.money({ required: true, min: 0 }),
    },
    { max: 100 }
  ),
  transaction_date: v.datetime({ required: true }),
};

router.get(
  "/in-house",
  requireScope(SCOPES.FOLIO_READ),
  asyncHandler(async (req, res) => {
    const { room_number } = validate(req.query, { room_number: v.string({ required: true, max: 10 }) });
    ok(res, await pos.lookupInHouse(room_number));
  })
);

router.post(
  "/room-charges",
  requireScope(SCOPES.ROOM_CHARGES_WRITE),
  asyncHandler(async (req, res) => {
    const input = validate(req.body, chargeSchema);
    input.currency = input.currency.toUpperCase();
    created(res, await pos.postRoomCharge(input));
  })
);

router.get(
  "/room-charges/:externalTransactionId",
  requireScope(SCOPES.FOLIO_READ),
  asyncHandler(async (req, res) => ok(res, await pos.getRoomCharge(req.params.externalTransactionId)))
);

export default router;
