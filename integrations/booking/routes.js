/**
 * Guest Booking System endpoints — mounted at /api/v1/integrations/booking
 * Auth: BOOKING_API_KEY. Writes require an Idempotency-Key header.
 */
import express from "express";
import { asyncHandler, ok, created } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";
import * as booking from "./bookingService.js";

const router = express.Router();
const read = requireScope(SCOPES.RESERVATIONS_READ);
const write = requireScope(SCOPES.RESERVATIONS_WRITE);

const PAYMENT_STATUSES = ["UNPAID", "DEPOSIT_PAID", "PREPAID", "REFUNDED"];
const EXTERNAL_ID = { max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" };
const guestSchema = (required) => ({
  first_name: v.string({ required, max: 80 }),
  last_name: v.string({ required, max: 80 }),
  email: v.email(),
  phone: v.phone(),
});
const bookingFields = (required) => ({
  room_type_id: v.int({ min: 1 }),
  room_type: v.string({ max: 50 }),
  check_in_date: v.date({ required }),
  check_out_date: v.date({ required }),
  number_of_guests: v.int({ required, min: 1, max: 20 }),
  booking_reference: v.string({ max: 100 }),
  payment_status: v.enum(PAYMENT_STATUSES),
  notes: v.string({ max: 500 }),
});

router.get("/room-types", read, asyncHandler(async (req, res) => ok(res, await booking.roomTypes())));

router.get(
  "/availability",
  read,
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      check_in_date: v.date({ required: true }),
      check_out_date: v.date({ required: true }),
      room_type_id: v.int({ min: 1 }),
    });
    ok(res, await booking.availability(q));
  })
);

router.post(
  "/reservations",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      external_reservation_id: v.string({ required: true, ...EXTERNAL_ID }),
      guest: v.object(guestSchema(true), { required: true }),
      ...bookingFields(true),
    });
    created(res, await booking.createFromBooking(input));
  })
);

router.get("/reservations/:externalReservationId", read, asyncHandler(async (req, res) => ok(res, await booking.getBooking(req.params.externalReservationId))));

router.patch(
  "/reservations/:externalReservationId",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(req.body, { guest: v.object(guestSchema(false)), ...bookingFields(false) }, { partial: true });
    ok(res, await booking.updateFromBooking(req.params.externalReservationId, input));
  })
);

router.post(
  "/reservations/:externalReservationId/cancel",
  write,
  asyncHandler(async (req, res) => {
    const { reason } = validate(req.body, { reason: v.string({ max: 255 }) });
    ok(res, await booking.cancelFromBooking(req.params.externalReservationId, reason));
  })
);

export default router;
