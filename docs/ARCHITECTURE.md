# Architecture

## 1. Scope

The system is the **Hotel FrontDesk and Property Management System** only. Its functional source of truth is the diagram set (Figures 2–17 and the Hotel Check-in and Checkout Flowchart).

| In scope (from the diagrams) | Small extensions (approved) | Out of scope |
|---|---|---|
| Display reservation (1.0) | Walk-in / phone reservation entry, so the PMS works without the external booking system | Guest Booking System (Member 1), restaurant ordering / POS (Member 4) |
| Verify guest identity, retry until verified (2.0) | Housekeeping coordination: room DIRTY at checkout, RoomVacated to the Housekeeping System, CLEANING / ready reported back; front-desk "Mark clean" fallback | Housekeeping staff, schedules, task progress (Member 3) |
| Check in, stay record (3.0, 4.0) | Read-only reports built from existing records | HR, attendance, payroll (Member 5) |
| Update room status (5.0) | `CANCELLED` reservation status (needed for cancellation sync) | Partial payments, deposits, stay extensions |
| | Room moves for in-house guests (before the bill is generated) | |
| | Room status lifecycle AVAILABLE / RESERVED / OCCUPIED / DIRTY / CLEANING / MAINTENANCE (state machine + audit log); Inactive / Deleted display states | |
| | Guest folio statement (room, restaurant, other charges, adjustments, payments, balance) | |
| | Integration layer for Members 1, 3, 4, 5 (see section 7) | |
| | Room delete (permanent if never booked, otherwise archived) and restore | |
| | Self-service password change, admin password reset with forced change, session invalidation | |
| Generate / adjust final bill (6.0, 7.0) | Room `isActive` (take a room out of service without deleting history) | |
| Process / retry payment (8.0, 9.0) | | |
| Receipt and checkout | | |
| Maintain rooms and staff (10.0) | | |

## 2. Layers and components (Figures 2, 3, 6)

```
Front Desk Web App / Admin Console  (views/*.xian shells + public/js modules)
        │  REST API, HTTPS/JSON  (/api/v1, session cookie + CSRF token)
        ▼
API Router and Authentication (role-based access)      routes/, middleware/auth.js, middleware/csrf.js
        │
        ├── Reservation Service ............ services/reservationService.js, availabilityService.js, guestService.js
        ├── Identity Verification Service .. services/verificationService.js
        ├── Check-in and Stay Service ...... services/stayService.js
        ├── Room Status Service ............ services/roomStatusService.js (state machine, audit log), roomService.js (markClean)
        ├── Guest Folio Service ............ services/folioService.js (statement, posting charges)
        ├── Billing Service ................ services/billingService.js
        ├── Payment Service ─────────────► Payment Gateway Adapter (integrations/paymentGateway) ─► external gateway
        ├── Receipt and Checkout Service ... services/checkoutService.js
        └── Room and Staff Admin Service ... services/roomService.js, staffService.js
        │
        ▼
Data Access Layer (Sequelize models, transactions)      models/
        │  SQL over TCP 3306
        ▼
Hotel Database (MySQL 8): 18 tables + v_bill_total view

Member systems ─► /api/v1/integrations/{booking,pos,housekeeping,hr}   integrations/
                  (API key + scopes, HMAC signatures, rate limit, idempotency; mounted before session/CSRF)
Domain events ─► integration_events + integration_outbox (same transaction) ─► signed webhooks to the members
```

Rules that keep the design modular:

- **Controllers are thin**: validate input (`utils/validate.js`), call one service, return the JSON envelope.
- **Services own business rules and transactions.** Every multi-step change (check-in, payment, checkout) runs in one MySQL transaction with row locks, so it either fully happens or not at all.
- **The core never imports integration code.** Core services raise domain events (`services/domainEvents.js`, payloads in `services/eventPayloads.js`); the integration layer subscribes and writes the event log and webhook rows in the same transaction. Integration modules call core services (never the other way round), so every external request obeys the same business rules as the front desk.
- **Room status changes only through `roomStatusService.transition`**, which enforces the lifecycle, writes `room_status_logs` and raises `RoomStatusChanged`.
- **The Payment module only knows the adapter interface** `authorize({ amount, currency, method, paymentToken, reference })`. A real gateway is a new driver file.

## 3. Database relationships

Tables use snake_case columns, InnoDB, utf8mb4. All foreign keys are `ON DELETE RESTRICT`, so operational history can't be deleted by accident. The exception is `bill_adjustments`, which is composed by `bills` (Figure 2's filled diamond) and uses `CASCADE`.

```
users (Receptionist | Administrator; role, is_active)
  ▲ checked_in_by / checked_out_by / verified_by / generated_by / adjusted_by / received_by / created_by / last_cleaned_by

room_types 1 ──< rooms                              (rooms.room_type → room_types.name, ON UPDATE CASCADE; id = room_type_id for the Booking System)
rooms 1 ──< room_status_logs                        (every status transition: from, to, reason, source, actor_user_id, reference)
rooms 1 ──< housekeeping_tasks >── 0..1 stays       (reference to a task in the Housekeeping System; UNIQUE(external_task_id))
guests 1 ──< reservations >── 0..1 rooms            ("makes", "books"; room_id NULL until assigned)
reservations 1 ──< identity_verifications           ("verifies"; UNIQUE(reservation_id, attempt_no))
reservations 1 ── 0..1 stays                        ("becomes"; UNIQUE(reservation_id))
stays 1 ──< stay_charges                            (guest folio, POS charges; UNIQUE(source_system, external_transaction_id))
stays 1 ── 0..1 bills                               ("billed as"; UNIQUE(stay_id))
bills 1 ◆──< bill_adjustments                       ("contains")
bills 1 ──< payments                                ("paid by"; UNIQUE(bill_id, attempt_no))
payments 1 ── 0..1 receipts                         ("issues"; UNIQUE(payment_id), UNIQUE(receipt_no))

integration_requests   inbound idempotency + audit log; UNIQUE(source, idempotency_key); source = BOOKING | POS | HOUSEKEEPING | HR
integration_events 1 ──< integration_outbox
  integration_events   every published event; UNIQUE(event_id = EVT-000001), event_type, aggregate (ROOM / RESERVATION / STAY), payload
  integration_outbox   webhook delivery log, one row per (event, receiving system): PENDING → SENT | FAILED | SKIPPED, attempts, last error / HTTP status
sessions               server-side login sessions

VIEW v_bill_total(bill_id, room_charge, charges_total, adjustments_total, total_due)
     total_due = room_charge + SUM(stay_charges) + SUM(bill_adjustments)
```

Design notes:

- **External identifiers are separate from primary keys.** `reservations(source, external_reservation_id)`, `stay_charges(source_system, external_transaction_id)` and `housekeeping_tasks(external_task_id)` are unique, which is what makes duplicate bookings, charges and cleaning completions impossible even when a system re-sends under a new Idempotency-Key. The PMS returns its own `reservation_id` / `stay_id` so the systems can refer to the same stay.
- **Room status vs. availability.** `rooms.status` is the physical / operational state (lifecycle in section 7). Whether a room can be sold for given dates is always computed from reservation dates, so a room RESERVED for next month can still be booked tonight.
- **No HR data in the PMS.** `housekeeping_tasks.started_by / completed_by` are the Housekeeping System's employee ids, stored only as references.
- **`reservations.room_type`** is kept even when a room is assigned, because external bookings arrive by room type before a room exists. The service keeps it consistent with the assigned room.
- **The total due is never stored.** It's always derived by `v_bill_total`, so a bill can't drift from its lines.
- **`bills.nightly_rate`** is a snapshot of the room rate when the bill was generated, so later rate changes don't alter issued bills.
- **Identity data minimisation:** only `id_type` and the last 4 characters of the ID number are stored. The name on the ID and its expiry are checked but never persisted.
- **Money** is `DECIMAL(10,2)` in the database and integer cents in JS arithmetic (`utils/money.js`).
- **Indexes** cover the frequent searches: reservation status, dates, room type, guest name, email and phone, and room status.

## 4. Main workflows (Figures 11–15)

| Step | Endpoint | Rules (enforced server-side) |
|---|---|---|
| Display reservation | `GET /reservations?view=arrivals`, `GET /reservations/{code}` | |
| Assign room | `PUT /reservations/{id}/room` | Room active, capacity ≥ guests, no overlapping active reservation on that room. New room AVAILABLE → RESERVED; previous room RESERVED → AVAILABLE when nothing else is assigned to it |
| Verify identity | `POST /verifications` | Name on ID must contain the guest's first and last names; ID not expired; photo matches. Every attempt is saved with an increasing attempt number |
| Check in | `POST /check-ins` | Reservation CONFIRMED, today ∈ [check-in, check-out), room assigned and AVAILABLE / RESERVED (DIRTY / CLEANING → `ROOM_NOT_READY`), latest verification VERIFIED. Then stay (check-in time) + CHECKED_IN + room OCCUPIED + `GuestCheckedIn` in one transaction |
| Generate bill | `POST /bills` | Stay in-house. Nights = max(1, check-in date → today) × room rate. Regenerating a DRAFT keeps adjustments |
| Adjust bill | `POST /bills/{id}/adjustments` | DRAFT only; signed amount; total can't go negative |
| Confirm bill | `POST /bills/{id}/confirm` | DRAFT → CONFIRMED; the bill is frozen and the POS folio closes |
| Pay / retry | `POST /payments` | Bill CONFIRMED; amount must equal the total due; every attempt is saved. Success → receipt `OR-000001` + bill PAID. The bill row is locked, so no double charge |
| Checkout | `POST /checkouts` | Bill PAID (folio balance 0). Then stay (checkout time) + CHECKED_OUT + room **DIRTY** + `GuestCheckedOut` (with the folio summary) + `RoomVacated` in one transaction. The room becomes AVAILABLE only when housekeeping completes cleaning |
| Guest folio | `GET /stays/{id}/folio` | Room charges (accrued, then billed), restaurant and other charges, adjustments, successful payments, balance. Equals `v_bill_total` once the bill exists |

Overbooking protection (`services/availabilityService.js`): all active rooms of the requested type are locked with `SELECT … FOR UPDATE` for the whole booking transaction. For every night of the stay, the number of overlapping active reservations of that type must stay below the number of rooms. The concurrency test books the last room twice in parallel; exactly one request succeeds.

## 5. Security

- **Authentication:** session cookie (`httpOnly`, `SameSite=Lax`, `Secure` in production), sessions stored in MySQL, session id regenerated at login. Login failures return one generic message, take the same time whether or not the user exists, and are rate-limited (10/min/IP).
- **Passwords:** bcrypt with cost 12. Hashes are excluded from every query by default (Sequelize default scope).
- **Authorization:** `receptionistOnly` / `adminOnly` / `anyStaff` on every route, checked again for pages.
- **CSRF:** synchroniser token in the session, sent as `X-CSRF-Token` (fetch) or `_csrf` (forms).
- **Input validation:** whitelisting validator on every endpoint. Unknown fields are dropped and all errors are reported as a 422 with field details. Path ids are checked to be integers before any query.
- **SQL injection:** only Sequelize parameterised queries and `replacements` in raw SQL.
- **Headers:** strict Content-Security-Policy (no inline scripts or styles), `X-Frame-Options: DENY`, `nosniff`, `no-store` on API responses.
- **Secrets** come only from environment variables. The server refuses to start in production without `SESSION_SECRET`, or with the sandbox payment gateway.
- **Integrations:**
  - **Credentials:** a separate API key per system, compared in constant time against all keys.
  - **Authorization:** scope-based; a key used on another system's endpoint gets 403.
  - **Signing:** HMAC-SHA256 request signatures with a 5-minute timestamp window (replay protection), required for systems given an inbound secret, i.e. Housekeeping. HMAC-signed webhooks out.
  - **Transport and throttling:** HTTPS enforced in production; rate limits per IP and per system.
  - **Duplicate protection:** Idempotency-Keys plus unique external references.
  - **Privacy:** integration responses and events expose references and statuses only, never guest contact or ID data.
  - **Audit:** inbound writes are recorded in `integration_requests`, events in `integration_events`, deliveries in `integration_outbox`.
- **Audit:** who and when are stored on each record (checked in/out by, verified by, generated by, adjusted by, received by, cleaned by). Important events are logged as structured JSON lines.

## 6. Deployment (Figure 4)

Single-hotel deployment:
- Nginx terminates TLS and serves static files, then proxies to `node index.js`.
- Set `TRUST_PROXY=true` and `SESSION_SECURE_COOKIE=true`.
- MySQL 8 runs on a private network, port 3306.
- Schedule `npm run backup` nightly (cron or Windows Task Scheduler; see `scripts/backup.js`).
- The Electron shell from the XianFire template still works for a front-desk PC (`npm run run`).
- Integrations: give each member only their own key / secrets; webhook URLs must be HTTPS (non-HTTPS deliveries are refused in production). With several app instances the outbox worker is still safe: rows are claimed with `SELECT … FOR UPDATE SKIP LOCKED`.

## 7. Inter-system integration

Full contract for the member systems: [INTEGRATIONS.md](INTEGRATIONS.md).

| Member | System | Direction | Interface |
|---|---|---|---|
| 1 | Guest Booking System | → PMS | `/integrations/booking/*`: reservations (auto room assignment, no double booking), room types, availability |
| | | PMS → | `GuestCheckedIn`, `GuestCheckedOut`, `ReservationUpdated`, `ReservationCancelled` (its own bookings, never echoed) |
| 3 | Housekeeping System | PMS → | `RoomVacated`, `RoomStatusChanged`, `RoomCleaned` |
| | | → PMS | `/integrations/housekeeping/*`: cleaning-tasks, cleaning-started (DIRTY → CLEANING), cleaning-completed (→ AVAILABLE / RESERVED), room board |
| 4 | Restaurant POS | → PMS | `/integrations/pos/*`: in-house lookup, room-charges (validated against the active reservation and room) |
| | | PMS → | `GuestCheckedIn`, `GuestCheckedOut` |
| 5 | HR and Payroll | → PMS (read) | `/integrations/hr/housekeeping-tasks`: verify job logs that Housekeeping sends **directly** to HR |

**Why Housekeeping → HR is direct.** The job log is Housekeeping's own data: employee, start time, duration. Routing it through the PMS would copy employee data into the PMS and make the PMS depend on HR's format, while adding no business rule. The PMS only exposes what it independently knows (which task completed which room, when, and the employee id reported), so HR can verify a log before crediting work.

**Reliability.** Events are written in the business transaction (transactional outbox), delivered at-least-once with exponential backoff, then FAILED and re-sendable by an administrator. Receivers de-duplicate on `event_id`. Inbound duplicates are stopped by Idempotency-Keys and by unique external references.

**Room status lifecycle** (`services/roomStatusService.js`):

| From | Allowed to |
|---|---|
| AVAILABLE | RESERVED (reservation assigned), OCCUPIED (check-in / room move), MAINTENANCE |
| RESERVED | AVAILABLE (last assignment released), OCCUPIED, MAINTENANCE |
| OCCUPIED | DIRTY (checkout / room move) |
| DIRTY | CLEANING (housekeeping starts), MAINTENANCE |
| CLEANING | AVAILABLE or RESERVED (cleaning completed), DIRTY, MAINTENANCE |
| MAINTENANCE | AVAILABLE or RESERVED (back in service), DIRTY |

"Ready" resolves to RESERVED when a confirmed reservation is assigned to the room, otherwise AVAILABLE. Reservation status (CONFIRMED → CHECKED_IN → CHECKED_OUT / CANCELLED) is managed independently. Existing databases are migrated by `npm run migrate`: VACANT + needs cleaning → DIRTY, VACANT with an assigned confirmed reservation → RESERVED, other VACANT → AVAILABLE.
