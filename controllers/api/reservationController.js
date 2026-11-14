import { asyncHandler, ok, created, pagination } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { RESERVATION_STATUS } from "../../models/index.js";
import * as reservations from "../../services/reservationService.js";

const guestSchema = {
  firstName: v.string({ required: true, max: 80 }),
  lastName: v.string({ required: true, max: 80 }),
  email: v.email(),
  phone: v.phone(),
};

export const list = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    search: v.string({ max: 100 }),
    status: v.enum(Object.values(RESERVATION_STATUS)),
    view: v.string({ max: 20, pattern: /^(arrivals|departures|upcoming|in-house)$/, patternMessage: "Unknown view." }),
    date: v.date(),
  });
  const result = await reservations.listReservations({ ...q, ...pagination(req.query) });
  ok(res, result.data, result.meta);
});

export const show = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Accepts either the numeric id or the reservation code (GET /reservations/{code} in the sequence diagram).
  const data = /^\d+$/.test(id) ? await reservations.getReservation(Number(id)) : await reservations.getReservationByCode(id);
  ok(res, data);
});

export const create = asyncHandler(async (req, res) => {
  const input = validate(req.body, {
    guestId: v.int({ min: 1 }),
    guest: v.object(guestSchema),
    roomType: v.string({ max: 50 }),
    roomId: v.int({ min: 1 }),
    checkInDate: v.date({ required: true }),
    checkOutDate: v.date({ required: true }),
    numGuests: v.int({ required: true, min: 1, max: 20 }),
    notes: v.string({ max: 500 }),
  });
  if (!input.guestId && !input.guest) validate({}, { guest: v.object(guestSchema, { required: true }) });
  if (!input.roomType && !input.roomId) validate({}, { roomType: v.string({ required: true }) });
  created(res, await reservations.createReservation(input, { actor: req.user }));
});

export const assignRoom = asyncHandler(async (req, res) => {
  const { roomId } = validate(req.body, { roomId: v.int({ required: true, min: 1 }) });
  ok(res, await reservations.assignRoom(Number(req.params.id), roomId, { actor: req.user }));
});

export const assignableRooms = asyncHandler(async (req, res) => {
  const { allTypes } = validate(req.query, { allTypes: v.bool() });
  ok(res, await reservations.assignableRooms(Number(req.params.id), { allTypes }));
});
