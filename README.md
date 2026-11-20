# Hotel FrontDesk and Property Management System (PMS)

A front-desk PMS built on the XianFire framework (Express + Sequelize + MySQL 8, Handlebars `.xian` views, optional Electron shell). It implements the workflow from the project diagrams (Figures 2–17 and the check-in/checkout flowchart):

> Display reservation → verify guest identity (retry until verified) → check in (stay record, room Occupied) → generate final bill → adjust → confirm → process payment (show "payment failed", retry) → receipt → checkout (room Vacant)

Two roles from the class diagram: **Receptionist** (front-desk operations) and **Administrator** (rooms, staff accounts, integration monitoring).

This PMS is the **central system (Member 2)** of a five-system hotel project. The **Guest Booking System** (Member 1), **Housekeeping System** (Member 3), **Restaurant POS** (Member 4) and **HR and Payroll** (Member 5) are separate applications developed independently. They connect only through the authenticated integration API and signed webhooks; see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for the guide each member follows. The PMS is the source of truth for reservations, room assignments, room status (AVAILABLE → RESERVED → OCCUPIED → DIRTY → CLEANING → AVAILABLE, plus MAINTENANCE), check-in / check-out and the guest folio.

## Quick start

Requirements: Node.js ≥ 20.12, MySQL 8 (tested with 8.4).

```bash
npm install
cp .env.example .env            # then set SESSION_SECRET and DB_* values
npm run migrate -- --seed       # creates the database, 18 tables + v_bill_total view, sample rooms and 2 staff accounts
npm start                       # http://localhost:3000
```

`--seed` prints the generated passwords for `admin` (Administrator) and `frontdesk` (Receptionist) once; set `SEED_ADMIN_PASSWORD` / `SEED_RECEPTIONIST_PASSWORD` to choose them. Without `--seed`, opening the app shows a one-time **first-run setup** page that creates the first Administrator.

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Start the server (dev = nodemon auto-reload) |
| `npm run migrate` | Create database/tables/view if missing and add new columns to existing tables — **non-destructive, safe to re-run** |
| `npm run migrate -- --seed` | …and insert sample rooms + staff (only into empty tables) |
| `npm run migrate:fresh` | **Drop and recreate all tables** + seed (development only; asks to confirm) |
| `npm test` | Jest: 192 automated tests against a separate `FrontDesk_test` database |
| `npm run backup` | `mysqldump` snapshot to `backups/` with 14-day retention (Figure 4 "nightly backup") |
| `npm run route:list` | Print all registered routes |
| `npm run run` / `npm run dist` | Electron desktop shell / build installer (unchanged from XianFire) |

## Project structure

```
config/              environment-driven configuration (no secrets in code)
models/              Sequelize models (class diagram) + associations + v_bill_total view
services/            business logic, one service per diagram module (transactions live here)
controllers/         thin HTTP handlers: validate → call service → JSON
  api/               staff REST API controllers
routes/              index.js (pages, auth) + api/v1.js (staff REST API)
integrations/        the other members' systems — kept separate from the core
  shared/            client registry + scopes, API-key / signature auth, idempotency, event log + outbox, webhook delivery
  booking/           Member 1 Guest Booking System (reservations, availability, room types)
  pos/               Member 4 Restaurant POS (purchase notifications for front-desk review; legacy charge to room)
  housekeeping/      Member 3 Housekeeping System (cleaning started / completed, room board)
  hr/                Member 5 HR and Payroll (read-only verification of housekeeping tasks)
  paymentGateway/    Payment Gateway Adapter (sandbox driver)
middleware/          session auth + roles, CSRF, rate limiting, errors, DB session store
utils/               validation, money (integer cents), dates (hotel timezone), logging
views/               .xian page shells (layout partials, auth pages)
public/css, public/js  stylesheet; core/ reusable UI modules, pages/ one module per page
scripts/             seed, backup
__tests__/           Jest suites (workflow TC-1…TC-7, integrations, security, utils)
docs/                architecture, API reference, integration guide, Postman collection
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, diagram traceability, database relationships, workflows, security, scope decisions
- [docs/API.md](docs/API.md): staff REST API reference with request/response examples
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): how to connect a POS or Hotel Reservation System (auth, idempotency, webhooks)
- [docs/STAYBOOK.md](docs/STAYBOOK.md): StayBook online booking ↔ Frontdesk integration (room mapping, contract, retries, what StayBook must add)
- [docs/POS_ORDERS.md](docs/POS_ORDERS.md): Restaurant POS purchase notifications → front-desk review → guest folio (contract, statuses, security, setup, go-live checklist)
- [docs/postman/HotelFrontDesk-PMS.postman_collection.json](docs/postman/HotelFrontDesk-PMS.postman_collection.json): importable Postman collection

## Testing

```bash
npm test
```

Tests use real HTTP requests against the real Express app and a real MySQL database (`FrontDesk_test`, recreated on each run), with no mocks. They cover the seven requirement test cases from Figure 17 (TC-1…TC-7), overbooking under concurrent requests, all four member systems simulated end to end (booking → check-in → POS charges → folio and bill → checkout → RoomVacated → housekeeping → HR verification), the room status state machine, duplicates and idempotent retries, unauthorised / wrong-scope / unsigned requests, signed webhooks with retries and duplicate delivery, role-based access and CSRF.
