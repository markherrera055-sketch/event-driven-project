/**
 * Staff REST API — /api/v1  (session cookie + X-CSRF-Token).
 * Roles (class diagram): Receptionist runs the front-desk workflow;
 * Administrator manages rooms and staff. Both can read operational data.
 *
 * External systems do NOT use these routes; see /api/v1/integrations.
 */
import express from "express";
import { anyStaff, anyStaffAccount, receptionistOnly, adminOnly } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import * as reservation from "../../controllers/api/reservationController.js";
import * as desk from "../../controllers/api/frontDeskController.js";
import * as property from "../../controllers/api/propertyController.js";
import * as admin from "../../controllers/api/adminController.js";
import * as account from "../../controllers/api/accountController.js";
import { Reservation } from "../../models/index.js";
import { fail } from "../../utils/http.js";

const router = express.Router();
// Guessing the current password through the change-password form is throttled per account.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  key: (req) => `pwchange:${req.session.userId || req.ip}`,
  message: "Too many password change attempts. Please wait 15 minutes and try again.",
});

// :id must be a positive integer. For reservations a code (RSV-0001) is also
// accepted and resolved to the numeric id.
router.param("id", async (req, res, next, id) => {
  try {
    if (/^\d{1,10}$/.test(id) && Number(id) > 0) return next();
    if (req.path.startsWith("/reservations/") && /^[A-Z]{3}-\d{1,10}$/i.test(id)) {
      const found = await Reservation.findOne({ where: { reservationCode: id.toUpperCase() }, attributes: ["id"] });
      if (found) {
        req.params.id = String(found.id);
        return next();
      }
    }
    return fail(res, 404, "NOT_FOUND", "Resource not found.");
  } catch (err) {
    next(err);
  }
});

// Session / account / dashboard / reports
router.get("/me", anyStaffAccount, property.me);
router.put("/me/password", anyStaffAccount, passwordLimiter, account.changePassword);
router.get("/dashboard", anyStaff, property.dashboard);
router.get("/reports/summary", anyStaff, property.report);

// Reservation module (1.0 Display Reservation, room assignment, walk-in / phone entry)
router.get("/reservations", anyStaff, reservation.list);
router.post("/reservations", receptionistOnly, reservation.create);
router.get("/reservations/:id", anyStaff, reservation.show);
router.get("/reservations/:id/assignable-rooms", receptionistOnly, reservation.assignableRooms);
router.put("/reservations/:id/room", receptionistOnly, reservation.assignRoom);
router.get("/reservations/:id/verifications", anyStaff, desk.listVerifications);

// Identity Verification module (2.0)
router.post("/verifications", receptionistOnly, desk.verifyIdentity);

// Check-in and Stay module (3.0, 4.0)
router.post("/check-ins", receptionistOnly, desk.checkIn);
router.get("/stays", anyStaff, desk.listStays);
router.get("/stays/:id", anyStaff, desk.showStay);

// Billing module (6.0, 7.0)
router.post("/bills", receptionistOnly, desk.generateBill);
router.get("/bills/:id/totals", anyStaff, desk.billTotals);
router.post("/bills/:id/adjustments", receptionistOnly, desk.adjustBill);
router.post("/bills/:id/confirm", receptionistOnly, desk.confirmBill);
router.get("/bills/:id/payments", anyStaff, desk.listPayments);

// Payment module (8.0, 9.0) and Receipt & Checkout module
router.post("/payments", receptionistOnly, desk.pay);
router.get("/receipts/:id", anyStaff, desk.showReceipt);
router.post("/checkouts", receptionistOnly, desk.processCheckout);

// Guests
router.get("/guests", anyStaff, property.listGuests);
router.get("/guests/:id", anyStaff, property.showGuest);
router.patch("/guests/:id", receptionistOnly, property.updateGuest);

// Rooms (Room Status module, read) + housekeeping
router.get("/rooms", anyStaff, property.listRooms);
router.get("/room-types", anyStaff, property.listRoomTypes);
router.get("/rooms/:id", anyStaff, property.showRoom);
router.post("/rooms/:id/clean", anyStaff, property.markRoomClean);

// Admin Console (Room and Staff Admin module)
router.post("/admin/rooms", adminOnly, admin.createRoom);
router.patch("/admin/rooms/:id", adminOnly, admin.updateRoom);
router.delete("/admin/rooms/:id", adminOnly, admin.deleteRoom);
router.post("/admin/rooms/:id/restore", adminOnly, admin.restoreRoom);
router.get("/admin/staff", adminOnly, admin.listStaff);
router.post("/admin/staff", adminOnly, admin.createStaff);
router.patch("/admin/staff/:id", adminOnly, admin.updateStaff);
router.post("/admin/staff/:id/reset-password", adminOnly, admin.resetStaffPassword);
router.get("/admin/integrations", adminOnly, admin.integrations);
router.post("/admin/integrations/outbox/:id/retry", adminOnly, admin.retryOutbox);

export default router;
