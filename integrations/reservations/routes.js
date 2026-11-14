/**
 * Hotel Reservation System endpoints — mounted at /api/v1/integrations/reservations
 * Auth: X-Api-Key = RESERVATION_API_KEY. Writes require an Idempotency-Key header.
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import * as sync from "./reservationSyncService.js";

const router = express.Router();

const PAYMENT_STATUSES = ["UNPAID", "DEPOSIT_PAID", "PREPAID", "REFUNDED"];
const guestSchema = (required) => ({
  firstName: v.string({ required, max: 80 }),
  lastName: v.string({ required, max: 80 }),
  email: v.email(),
  phone: v.phone(),
});
const extId = v.string({ required: true, max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" });

router.get("/room-types", asyncHandler(async (req, res) => ok(res, await sync.roomTypes())));

router.get(
  "/availability",
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      checkInDate: v.date({ required: true }),
      checkOutDate: v.date({ required: true }),
      roomType: v.string({ max: 50 }),
    });
    ok(res, await sync.availability(q));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      externalReservationId: extId,
      bookingReference: v.string({ max: 100 }),
      guest: v.object(guestSchema(true), { required: true }),
      roomType: v.string({ required: true, max: 50 }),
      checkInDate: v.date({ required: true }),
      checkOutDate: v.date({ required: true }),
      numGuests: v.int({ required: true, min: 1, max: 20 }),
      paymentStatus: v.enum(PAYMENT_STATUSES),
      notes: v.string({ max: 500 }),
    });
    created(res, await sync.createFromExternal(input));
  })
);

router.get("/:externalReservationId", asyncHandler(async (req, res) => ok(res, await sync.getExternal(req.params.externalReservationId))));

router.patch(
  "/:externalReservationId",
  asyncHandler(async (req, res) => {
    const input = validate(
      req.body,
      {
        bookingReference: v.string({ max: 100 }),
        guest: v.object({
          firstName: v.string({ max: 80 }),
          lastName: v.string({ max: 80 }),
          email: v.email(),
          phone: v.phone(),
        }),
        roomType: v.string({ required: true, max: 50 }),
        checkInDate: v.date({ required: true }),
        checkOutDate: v.date({ required: true }),
        numGuests: v.int({ required: true, min: 1, max: 20 }),
        paymentStatus: v.enum(PAYMENT_STATUSES),
        notes: v.string({ max: 500 }),
      },
      { partial: true }
    );
    ok(res, await sync.updateFromExternal(req.params.externalReservationId, input));
  })
);

router.post(
  "/:externalReservationId/cancel",
  asyncHandler(async (req, res) => {
    const { reason } = validate(req.body, { reason: v.string({ max: 255 }) });
    ok(res, await sync.cancelFromExternal(req.params.externalReservationId, reason));
  })
);

export default router;
