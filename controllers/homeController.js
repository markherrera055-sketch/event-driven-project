
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
    /**
 * Page controller. Each page is a server-rendered shell (layout, navigation,
 * CSRF token, page id); the page's ES module in /public/js/pages loads its data
 * from the /api/v1 REST API — the "Front Desk Web App" / "Admin Console" of
 * the component diagram.
 */
import { config } from "../config/index.js";

export const homePage = (req, res) => res.redirect(req.session.userId ? "/dashboard" : "/login");

const page = (view, title, nav, extra = {}) => (req, res, next) => {
  // Detail pages take a positive integer id; anything else is a 404.
  if (req.params.id !== undefined && !/^\d{1,10}$/.test(req.params.id)) return next();
  return res.render(view, { title, nav, page: view.replaceAll("/", "-"), hotelName: config.hotel.name, currency: config.hotel.currency, ...extra(req) });
};

const none = () => ({});
const withId = (req) => ({ entityId: req.params.id });

export const dashboardPage = page("dashboard", "Dashboard", "dashboard", none);
export const reservationsPage = page("frontdesk/reservations", "Reservations", "reservations", none);
export const reservationPage = page("frontdesk/reservation", "Reservation", "reservations", withId);
export const inHousePage = page("frontdesk/in-house", "In-house guests", "in-house", none);
export const stayPage = page("frontdesk/stay", "Guest folio", "in-house", withId);
export const receiptPage = page("frontdesk/receipt", "Receipt", "in-house", withId);
export const restaurantChargesPage = page("frontdesk/restaurant-charges", "Restaurant charges", "restaurant-charges", none);
export const guestsPage = page("guests", "Guests", "guests", none);
export const guestPage = page("guest", "Guest profile", "guests", withId);
export const roomsPage = page("rooms", "Room status", "rooms", none);
export const reportsPage = page("reports", "Reports", "reports", none);
export const accountPage = page("account", "Account settings", "account", none);
export const adminRoomsPage = page("admin/rooms", "Manage rooms", "admin-rooms", none);
export const adminStaffPage = page("admin/staff", "Staff accounts", "admin-staff", none);
export const adminIntegrationsPage = page("admin/integrations", "Integrations", "admin-integrations", none);
