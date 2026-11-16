/** Guests, rooms (read + housekeeping), dashboard and reports — shared by all staff. */
import { asyncHandler, ok, pagination } from "../../utils/http.js";
import { validate, v } from "../../utils/validate.js";
import { ROOM_STATUS } from "../../models/index.js";
import { addDays, today } from "../../utils/dates.js";
import * as guests from "../../services/guestService.js";
import * as rooms from "../../services/roomService.js";
import * as roomStatus from "../../services/roomStatusService.js";
import { getDashboard } from "../../services/dashboardService.js";
import { buildReport } from "../../services/reportService.js";
import { gatewayInfo } from "../../integrations/paymentGateway/index.js";
import { config } from "../../config/index.js";

// ── Guests ──────────────────────────────────────────────────────────────────
export const listGuests = asyncHandler(async (req, res) => {
  const { search } = validate(req.query, { search: v.string({ max: 100 }) });
  const result = await guests.searchGuests({ search, ...pagination(req.query) });
  ok(res, result.data, result.meta);
});

export const showGuest = asyncHandler(async (req, res) => ok(res, await guests.getGuest(Number(req.params.id))));

export const updateGuest = asyncHandler(async (req, res) => {
  const changes = validate(
    req.body,
    {
      firstName: v.string({ required: true, max: 80 }),
      lastName: v.string({ required: true, max: 80 }),
      email: v.email(),
      phone: v.phone(),
    },
    { partial: true }
  );
  ok(res, await guests.updateGuest(Number(req.params.id), changes));
});

// ── Rooms & housekeeping ────────────────────────────────────────────────────
export const listRooms = asyncHandler(async (req, res) => {
  const q = validate(req.query, {
    status: v.enum(Object.values(ROOM_STATUS)),
    roomType: v.string({ max: 50 }),
    search: v.string({ max: 10 }),
    needsCleaning: v.bool(),
    includeInactive: v.bool(),
    archived: v.bool(),
  });
  ok(res, await rooms.listRooms(q));
});

export const listRoomTypes = asyncHandler(async (req, res) => ok(res, await rooms.listRoomTypes()));
export const showRoom = asyncHandler(async (req, res) => ok(res, await rooms.getRoom(Number(req.params.id))));
export const markRoomClean = asyncHandler(async (req, res) => ok(res, await rooms.markClean(Number(req.params.id), req.user)));
export const roomStatusHistory = asyncHandler(async (req, res) => ok(res, await roomStatus.statusHistory(Number(req.params.id))));

// ── Dashboard / reports / session info ──────────────────────────────────────
export const dashboard = asyncHandler(async (req, res) => ok(res, await getDashboard()));

export const report = asyncHandler(async (req, res) => {
  const q = validate(req.query, { from: v.date(), to: v.date() });
  const to = q.to || today();
  const from = q.from || addDays(to, -6);
  ok(res, await buildReport({ from, to }));
});

export const me = (req, res) =>
  ok(res, {
    user: req.user.toSafeJSON(),
    hotel: { name: config.hotel.name, currency: config.hotel.currency, timezone: config.hotel.timezone, today: today() },
    paymentGateway: gatewayInfo(),
    // Lets non-browser clients (e.g. Postman) send X-CSRF-Token. Same-origin only: requires the session cookie.
    csrfToken: req.session.csrfToken,
  });
