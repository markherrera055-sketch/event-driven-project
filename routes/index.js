
  /*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
    
import express from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { anyStaff, anyStaffAccount, adminOnly } from "../middleware/auth.js";
import * as pages from "../controllers/homeController.js";
import {
  loginPage,
  loginUser,
  setupPage,
  setupAdministrator,
  registerPage,
  registerUser,
  forgotPasswordPage,
  logoutUser,
} from "../controllers/authController.js";
import apiV1 from "./api/v1.js";

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (req) => `login:${req.ip}` });

// ── Public / authentication ──────────────────────────────────────────────────
router.get("/", pages.homePage);
router.get("/login", loginPage);
router.post("/login", loginLimiter, loginUser);
router.get("/setup", setupPage);
router.post("/setup", loginLimiter, setupAdministrator);
router.get("/register", registerPage);
router.post("/register", registerUser);
router.get("/forgot-password", forgotPasswordPage);
router.post("/logout", logoutUser);
router.get("/logout", logoutUser);

// ── Front Desk Web App ───────────────────────────────────────────────────────
router.get("/dashboard", anyStaff, pages.dashboardPage);
router.get("/front-desk/reservations", anyStaff, pages.reservationsPage);
router.get("/front-desk/reservations/:id", anyStaff, pages.reservationPage);
router.get("/front-desk/in-house", anyStaff, pages.inHousePage);
router.get("/front-desk/stays/:id", anyStaff, pages.stayPage);
router.get("/front-desk/receipts/:id", anyStaff, pages.receiptPage);
router.get("/front-desk/restaurant-charges", anyStaff, pages.restaurantChargesPage);
router.get("/guests", anyStaff, pages.guestsPage);
router.get("/guests/:id", anyStaff, pages.guestPage);
router.get("/rooms", anyStaff, pages.roomsPage);
router.get("/reports", anyStaff, pages.reportsPage);
router.get("/account", anyStaffAccount, pages.accountPage);

// ── Admin Console ────────────────────────────────────────────────────────────
router.get("/admin/rooms", adminOnly, pages.adminRoomsPage);
router.get("/admin/staff", adminOnly, pages.adminStaffPage);
router.get("/admin/integrations", adminOnly, pages.adminIntegrationsPage);

// ── Staff REST API (session + CSRF) ─────────────────────────────────────────
router.use("/api/v1", apiV1);

export default router;
