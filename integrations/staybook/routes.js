/**
 * StayBook online booking endpoints — mounted at /api/v1/integrations/staybook
 * (the room-based contract proposed in StayBook's API documentation, adapted
 * to this API's conventions: versioned base path, snake_case, JSON envelope).
 *
 * Auth: StayBook is the Guest Booking System (Member 1), so it uses the
 * BOOKING_API_KEY (X-Api-Key or Authorization: Bearer) and its scopes.
 * Writes require an Idempotency-Key header (shared integration pipeline).
 *
 *   GET   /rooms/available?check_in&check_out&guests[&hotel_id]   mapped rooms bookable for the stay
 *   POST  /reservations                                            receive a new online booking
 *   GET   /reservations/{id}                                       acknowledgment / current state
 *   PATCH /reservations/{id}                                       later revision (dates, guests, room, quote, status)
 *   POST  /reservations/{id}/cancel                                cancellation
 * {id} = Frontdesk reservation id (digits) or the StayBook booking reference (e.g. SB-EXAMPLE12345).
 */
import express from "express";
import { asyncHandler, ok, created, fail } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { requireScope } from "../shared/auth.js";
import { SCOPES } from "../shared/clients.js";
import { config } from "../../config/index.js";
import * as staybook from "./staybookService.js";

const router = express.Router();
const read = requireScope(SCOPES.RESERVATIONS_READ);
const write = requireScope(SCOPES.RESERVATIONS_WRITE);

const ID = { max: 100, pattern: /^[A-Za-z0-9._:-]+$/, patternMessage: "Use letters, digits, . _ : -" };
const SMALL_ID = { ...ID, max: 50 };

/*
 * Only these fields are read; anything else in the body (address, card data,
 * payment details…) is dropped by the validator and never stored.
 */
const guestSchema = (required) => ({
  first_name: v.string({ required, max: 80 }),
  last_name: v.string({ required, max: 80 }),
  email: v.email(),
  phone: v.phone(),
});
const stayFields = (required) => ({
  hotel_id: v.string({ required, ...SMALL_ID }),
  staybook_room_id: v.string({ required, ...SMALL_ID }),
  frontdesk_room_id: v.int({ min: 1 }),
  check_in: v.date({ required }),
  check_out: v.date({ required }),
  guests: v.int({ required, min: 1, max: 20 }),
  nights: v.int({ required, min: 1, max: 60 }),
  nightly_rate: v.money({ required, min: 0 }),
  total_amount: v.money({ required, min: 0 }),
  currency: v.enum([config.hotel.currency], { required }),
  updated_at: v.datetime({ required: true }),
});

router.param("id", (req, res, next, id) =>
  /^[A-Za-z0-9._:-]{1,100}$/.test(id) ? next() : fail(res, 404, "RESERVATION_NOT_FOUND", "Unknown reservation id or booking reference.")
);

router.get(
  "/rooms/available",
  read,
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      check_in: v.date({ required: true }),
      check_out: v.date({ required: true }),
      guests: v.int({ required: true, min: 1, max: 20 }),
      hotel_id: v.string(SMALL_ID),
    });
    ok(res, await staybook.availableRooms(q));
  })
);

router.post(
  "/reservations",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(req.body, {
      source_system: v.enum(["STAYBOOK"], { required: true }),
      source_booking_id: v.string({ required: true, ...ID }),
      booking_reference: v.string({ required: true, ...ID }),
      guest: v.object(guestSchema(true), { required: true }),
      ...stayFields(true),
      // A booking must be active to be created; cancellations use /cancel.
      booking_status: v.enum(staybook.ACTIVE_STAYBOOK_STATUSES, { required: true }),
      payment_mode: v.enum(staybook.PAYMENT_MODES),
    });
    created(res, await staybook.createFromStaybook(input));
  })
);

router.get("/reservations/:id", read, asyncHandler(async (req, res) => ok(res, await staybook.getStaybookReservation(req.params.id))));

router.patch(
  "/reservations/:id",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(
      req.body,
      { guest: v.object(guestSchema(false)), ...stayFields(false), booking_status: v.enum(staybook.ACTIVE_STAYBOOK_STATUSES) },
      { partial: true }
    );
    if (input.updated_at === undefined) return fail(res, 422, "VALIDATION_ERROR", "Some fields are invalid.", { updated_at: "This field is required." });
    ok(res, await staybook.updateFromStaybook(req.params.id, input));
  })
);

router.post(
  "/reservations/:id/cancel",
  write,
  asyncHandler(async (req, res) => {
    const input = validate(req.body, { reason: v.string({ max: 255 }), updated_at: v.datetime() });
    ok(res, await staybook.cancelFromStaybook(req.params.id, input));
  })
);

export default router;
