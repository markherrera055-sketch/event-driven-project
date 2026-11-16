/**
 * Front-desk workflow endpoints, in the order of the sequence diagram (Figure 12):
 *   POST /verifications → POST /check-ins → POST /bills (+ /adjustments, /confirm)
 *   → POST /payments → receipt → POST /checkouts
 */
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { ID_TYPES, PAYMENT_METHOD, STAY_STATUS } from "../../models/index.js";
import * as verification from "../../services/verificationService.js";
import * as stays from "../../services/stayService.js";
import * as billing from "../../services/billingService.js";
import * as payments from "../../services/paymentService.js";
import * as checkout from "../../services/checkoutService.js";
import * as folio from "../../services/folioService.js";

// ── Identity verification ───────────────────────────────────────────────────
export const verifyIdentity = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    reservationId: v.int({ required: true, min: 1 }),
    idType: v.enum(ID_TYPES, { required: true }),
    idNumberLast4: v.string({ required: true, min: 4, max: 4, pattern: /^[A-Za-z0-9]{4}$/, patternMessage: "Enter the last 4 letters/digits of the ID number." }),
    nameOnId: v.string({ required: true, max: 160 }),
    expiryDate: v.date({ required: true }),
    photoMatches: v.bool({ required: true }),
  });
  created(res, await verification.verifyIdentity(input.reservationId, input, req.user));
});

export const listVerifications = asyncHandler(async (req, res) => {
  ok(res, await verification.listVerifications(Number(req.params.id)));
});

// ── Check-in & stays ────────────────────────────────────────────────────────
export const checkIn = asyncHandler(async (req, res) => {
  const { reservationId } = validate(req.body, { reservationId: v.int({ required: true, min: 1 }) });
  created(res, await stays.checkIn(reservationId, req.user));
});

export const listStays = asyncHandler(async (req, res) => {
  const q = validate(req.query, { status: v.enum(Object.values(STAY_STATUS)), search: v.string({ max: 100 }) });
  ok(res, await stays.listStays(q));
});

export const showStay = asyncHandler(async (req, res) => ok(res, await stays.getStay(Number(req.params.id))));
export const showFolio = asyncHandler(async (req, res) => ok(res, await folio.getFolio(Number(req.params.id))));

// ── Billing ─────────────────────────────────────────────────────────────────
export const generateBill = asyncHandler(async (req, res) => {
  const { stayId } = validate(req.body, { stayId: v.int({ required: true, min: 1 }) });
  await billing.generateFinalBill(stayId, req.user);
  created(res, await stays.getStay(stayId));
});

export const adjustBill = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    amount: v.money({ required: true, min: -99999999.99, nonZero: true }),
    reason: v.string({ required: true, min: 3, max: 255 }),
  });
  created(res, await billing.adjustBill(Number(req.params.id), input, req.user));
});

export const confirmBill = asyncHandler(async (req, res) => ok(res, await billing.confirmBill(Number(req.params.id), req.user)));
export const billTotals = asyncHandler(async (req, res) => ok(res, await billing.getBillTotals(Number(req.params.id))));

// ── Payments & receipts ─────────────────────────────────────────────────────
export const pay = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    billId: v.int({ required: true, min: 1 }),
    method: v.enum(Object.values(PAYMENT_METHOD), { required: true }),
    amount: v.money({ required: true, min: 0.01 }),
    paymentToken: v.string({ max: 200 }),
  });
  created(res, await payments.processPayment(input.billId, input, req.user));
});

export const listPayments = asyncHandler(async (req, res) => ok(res, await payments.listPayments(Number(req.params.id))));
export const showReceipt = asyncHandler(async (req, res) => ok(res, await checkout.getReceipt(Number(req.params.id))));

// ── Checkout ────────────────────────────────────────────────────────────────
export const processCheckout = asyncHandler(async (req, res) => {
  const { stayId } = validate(req.body, { stayId: v.int({ required: true, min: 1 }) });
  created(res, await checkout.processCheckout(stayId, req.user));
});
