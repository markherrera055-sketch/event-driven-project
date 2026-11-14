# Architecture

## 1. Scope

The system is the **Hotel FrontDesk and Property Management System** only. Its functional source of truth is the diagram set (Figures 2–17 and the Hotel Check-in and Checkout Flowchart).

| In scope (from the diagrams) | Small extensions (approved) | Out of scope |
|---|---|---|
| Display reservation (1.0) | Walk-in / phone reservation entry, so the PMS works without the external booking system | POS system, restaurant ordering |
| Verify guest identity, retry until verified (2.0) | Light housekeeping: room flagged "needs cleaning" at checkout, "Mark clean" action, check-in refused into an uncleaned room | Online booking platform |
| Check in, stay record (3.0, 4.0) | Read-only reports built from existing records | Partial payments, stay extensions |
| Update room status (5.0) | `CANCELLED` reservation status (needed for cancellation sync) | Cleaning as a room status (housekeeping stays a flag) |
| | Room moves for in-house guests (before the bill is generated) | |
| | `MAINTENANCE` room status; derived Reserved / Inactive display statuses | |
| | Room delete (permanent if never booked, otherwise archived) and restore | |
| | Self-service password change, admin password reset with forced change, session invalidation | |
| Generate / adjust final bill (6.0, 7.0) | Room `isActive` (take a room out of service without deleting history) | |
| Process / retry payment (8.0, 9.0) | Integration-ready API layer (future POS / Reservation System) | |
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
        ├── Room Status Service ............ services/roomService.js (setOccupied / setVacant / markClean)
        ├── Billing Service ................ services/billingService.js
        ├── Payment Service ─────────────► Payment Gateway Adapter (integrations/paymentGateway) ─► external gateway
        ├── Receipt and Checkout Service ... services/checkoutService.js
        └── Room and Staff Admin Service ... services/roomService.js, staffService.js
        │
        ▼
Data Access Layer (Sequelize models, transactions)      models/
        │  SQL over TCP 3306
        ▼
Hotel Database (MySQL 8): 14 tables + v_bill_total view

External systems (future) ─► /api/v1/integrations/{pos,reservations}   integrations/
                            (API key, rate limit, idempotency; mounted before session/CSRF)
```

Rules that keep the design modular:

- **Controllers are thin**: validate input (`utils/validate.js`), call one service, return the JSON envelope.
- **Services own business rules and transactions.** Every multi-step change (check-in, payment, checkout) runs in one MySQL transaction with row locks, so it either fully happens or not at all.
- **The core never imports POS or Reservation code.** Core services raise domain events (`services/domainEvents.js`); the integration layer subscribes and writes webhook rows into the outbox in the same transaction.
- **The Payment module only knows the adapter interface** `authorize({ amount, currency, method, paymentToken, reference })`. A real gateway is a new driver file.

## 3. Database relationships

Tables use snake_case columns, InnoDB, utf8mb4. All foreign keys are `ON DELETE RESTRICT`, so operational history can't be deleted by accident. The exception is `bill_adjustments`, which is composed by `bills` (Figure 2's filled diamond) and uses `CASCADE`.

```
users (Receptionist | Administrator; role, is_active)
  ▲ checked_in_by / checked_out_by / verified_by / generated_by / adjusted_by / received_by / created_by / last_cleaned_by

guests 1 ──< reservations >── 0..1 rooms            ("makes", "books"; room_id NULL until assigned)
reservations 1 ──< identity_verifications           ("verifies"; UNIQUE(reservation_id, attempt_no))
reservations 1 ── 0..1 stays                        ("becomes"; UNIQUE(reservation_id))
stays 1 ──< stay_charges                            (guest folio, POS charges; UNIQUE(source_system, external_transaction_id))
stays 1 ── 0..1 bills                               ("billed as"; UNIQUE(stay_id))
bills 1 ◆──< bill_adjustments                       ("contains")
bills 1 ──< payments                                ("paid by"; UNIQUE(bill_id, attempt_no))
payments 1 ── 0..1 receipts                         ("issues"; UNIQUE(payment_id), UNIQUE(receipt_no))

integration_requests   inbound idempotency + audit log; UNIQUE(source, idempotency_key)
integration_outbox     outbound webhooks (PENDING → SENT | FAILED | SKIPPED)
sessions               server-side login sessions

VIEW v_bill_total(bill_id, room_charge, charges_total, adjustments_total, total_due)
     total_due = room_charge + SUM(stay_charges) + SUM(bill_adjustments)
```

Design notes:

- **External identifiers are separate from primary keys.** `reservations(source, external_reservation_id)` and `stay_charges(source_system, external_transaction_id)` are unique per source. External systems never see or depend on our ids, except the `folioId`, which is the stay id, as a convenience for cross-checking.
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
| Assign room | `PUT /reservations/{id}/room` | Room active, capacity ≥ guests, no overlapping active reservation on that room |
| Verify identity | `POST /verifications` | Name on ID must contain the guest's first and last names; ID not expired; photo matches. Every attempt is saved with an increasing attempt number |
| Check in | `POST /check-ins` | Reservation CONFIRMED, today ∈ [check-in, check-out), room assigned and VACANT and clean, latest verification VERIFIED. Then stay + CHECKED_IN + room OCCUPIED in one transaction |
| Generate bill | `POST /bills` | Stay in-house. Nights = max(1, check-in date → today) × room rate. Regenerating a DRAFT keeps adjustments |
| Adjust bill | `POST /bills/{id}/adjustments` | DRAFT only; signed amount; total can't go negative |
| Confirm bill | `POST /bills/{id}/confirm` | DRAFT → CONFIRMED; the bill is frozen and the POS folio closes |
| Pay / retry | `POST /payments` | Bill CONFIRMED; amount must equal the total due; every attempt is saved. Success → receipt `OR-000001` + bill PAID. The bill row is locked, so no double charge |
| Checkout | `POST /checkouts` | Bill PAID. Then stay + CHECKED_OUT + room VACANT (needs cleaning) in one transaction |

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
- **Integrations:** a separate API key per system (constant-time comparison), per-system rate limit, idempotency keys, HMAC-signed webhooks. Integration responses expose references and statuses only, never guest contact or ID data.
- **Audit:** who and when are stored on each record (checked in/out by, verified by, generated by, adjusted by, received by, cleaned by). Important events are logged as structured JSON lines.

## 6. Deployment (Figure 4)

Single-hotel deployment:
- Nginx terminates TLS and serves static files, then proxies to `node index.js`.
- Set `TRUST_PROXY=true` and `SESSION_SECURE_COOKIE=true`.
- MySQL 8 runs on a private network, port 3306.
- Schedule `npm run backup` nightly (cron or Windows Task Scheduler; see `scripts/backup.js`).
- The Electron shell from the XianFire template still works for a front-desk PC (`npm run run`).
