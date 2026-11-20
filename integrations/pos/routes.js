/**
 * Restaurant POS endpoints — mounted at /api/v1/integrations/pos
 * Auth: POS_API_KEY (+ HMAC signature when POS_INBOUND_SECRET is set).
 * Writes require an Idempotency-Key header.
 *
 *   POST /orders                              purchase notification → front-desk review (docs/POS_ORDERS.md)
 *   GET  /orders/{restaurant_id}/{order_id}   review status of a notification
 *   GET  /in-house?room_number=               who is in the room (masked) and their reservation id
 *   POST /room-charges                        DEPRECATED direct posting to the folio (kept for existing clients)
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { CHARGE_CATEGORIES } from "../../models/index.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";
import * as pos from "./posService.js";
import * as orders from "./orderService.js";

const router = express.Router();

const ID = /^[A-Za-z0-9._:-]+$/;
const ID_MESSAGE = "Use letters, digits, . _ : -";

const orderSchema = {
  external_order_id: v.string({ required: true, max: 64, pattern: ID, patternMessage: ID_MESSAGE }),
  restaurant_id: v.string({ max: 40, pattern: ID, patternMessage: ID_MESSAGE }),
  outlet_name: v.string({ max: 80 }),
  customer_name: v.string({ max: 160 }),
  guest_id: v.int({ min: 1 }),
  reservation_id: v.int({ min: 1 }),
  reservation_code: v.string({ max: 30, pattern: /^[A-Za-z]{3}-\d{1,10}$/, patternMessage: "Reservation code, e.g. RSV-0007" }),
  room_number: v.string({ max: 10 }),
  items: v.array(
    {
      sku: v.string({ max: 50 }),
      name: v.string({ required: true, max: 100 }),
      description: v.string({ max: 255 }),
      category: v.enum(orders.ITEM_CATEGORIES),
      quantity: v.int({ required: true, min: 1, max: 1000 }),
      unit_price: v.money({ required: true, min: 0 }),
    },
    { required: true, max: 100 }
  ),
  subtotal: v.money({ required: true, min: 0 }),
  service_charge: v.money({ min: 0 }),
  tax: v.money({ min: 0 }),
  discount: v.money({ min: 0 }),
  total: v.money({ required: true, min: 0.01 }),
  currency: v.string({ required: true, min: 3, max: 3, pattern: /^[A-Za-z]{3}$/, patternMessage: "ISO 4217 code, e.g. PHP" }),
  ordered_at: v.datetime({ required: true }),
  payment_status: v.enum(Object.values(orders.POS_PAYMENT_STATUS), { required: true }),
  order_status: v.enum(Object.values(orders.POS_ORDER_LIFECYCLE), { required: true }),
};

router.post(
  "/orders",
  requireScope(SCOPES.POS_ORDERS_WRITE),
  asyncHandler(async (req, res) => {
    const { status, data } = await orders.receiveOrder(validate(req.body, orderSchema));
    ok(res, data, undefined, status);
  })
);

router.get(
  "/orders/:restaurantId/:externalOrderId",
  requireScope(SCOPES.POS_ORDERS_READ),
  asyncHandler(async (req, res) => {
    const p = validate(req.params, {
      restaurantId: v.string({ required: true, max: 40, pattern: ID, patternMessage: ID_MESSAGE }),
      externalOrderId: v.string({ required: true, max: 64, pattern: ID, patternMessage: ID_MESSAGE }),
    });
    ok(res, await orders.getOrder(p.restaurantId, p.externalOrderId));
  })
);

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
    // Kept working unchanged for existing POS clients; new integrations use POST /orders (staff review).
    res.set("Deprecation", "true");
    res.set("Link", '</api/v1/integrations/pos/orders>; rel="successor-version"');
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
