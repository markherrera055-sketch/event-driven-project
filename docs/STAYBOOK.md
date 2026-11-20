# StayBook ↔ Frontdesk integration

StayBook (online booking, Member 1) and the Frontdesk / PMS (Member 2) stay separate applications with separate databases. StayBook's **backend** sends each online booking to the Frontdesk API; the Frontdesk validates it, books the mapped room and returns an acknowledgment that StayBook stores. Later changes and cancellations follow the same path. Changes made at the front desk are pushed back to StayBook by signed webhooks.

```
Guest books on StayBook ──► StayBook saves booking (LOCAL_CONFIRMED, simulated payment)
                              │  backend → POST /api/v1/integrations/staybook/reservations
                              │  X-Api-Key + Idempotency-Key, JSON
                              ▼
                     Frontdesk: API key → rate limit → idempotency → validation
                              │  hotel_id ok? staybook_room_id mapped? dates / nights / guests / currency ok?
                              │  one DB transaction, room rows locked (no double booking):
                              │    guest found or created → CONFIRMED reservation of the mapped room → room RESERVED
                              │    + external_bookings row (StayBook ids, quote, status, revision)
                              ▼
                     201 { frontdesk_reservation_id, reservation_code, sync_status: "ACKNOWLEDGED", … }
                              │
StayBook stores frontdesk_reservation_id + integration_status = SYNCED   (or PENDING_RETRY / REJECTED)

Front desk changes / checks in / checks out a StayBook booking
                              └──► signed webhook to StayBook (ReservationUpdated, GuestCheckedIn, …), retried until 2xx
```

---

## 1. API compatibility report

### What existed on each side

| | StayBook (from `OnlineBooking-API-Documentation.docx`) | Frontdesk (this repo) |
|---|---|---|
| Server-to-server API | **None.** Session cookie `staybook.sid` + `X-CSRF-Token`, guest-session scoped. No JSON booking list for staff | `/api/v1/integrations/*` with per-system API keys, scopes, rate limits, Idempotency-Key, optional HMAC signing, outbox webhooks |
| Availability | `GET /rooms/search` (StayBook's own catalog; doesn't know walk-ins, occupancy, maintenance) | `GET /booking/availability`, **per room type** |
| Create booking | `POST /booking/preview` → `POST /api/bookings/confirm` (browser session flow) | `POST /booking/reservations`, **by room type** (`room_type_id`) |
| Read / cancel | `GET /api/bookings/current`, `POST /api/bookings/cancel` (current session only) | `GET` / `PATCH` / `POST …/cancel` on `/booking/reservations/{external_reservation_id}` |
| Room identity | StayBook `rooms.id` (+ `hotel.id`) | Frontdesk `rooms.id` / `room_number` (numbering is independent) |
| Statuses | `LOCAL_CONFIRMED`, `ADMIN_CONFIRMED`, `CANCELLED`; `integration_status: NOT_CONNECTED` | `CONFIRMED`, `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED` |
| Payments | Simulated (`PAID` / `REFUNDED` are demo values) | Real folio and payments at the front desk |
| Field style | camelCase for requests, snake_case in reservation objects | snake_case everywhere |

### Endpoint by endpoint

| Proposed in StayBook's doc | Status before | What was done |
|---|---|---|
| `GET /api/rooms/available` | Missing (type-level availability only) | **New** `GET /api/v1/integrations/staybook/rooms/available`: per mapped room, keyed by StayBook room id, with Frontdesk rates and reasons for unavailable rooms |
| `POST /api/reservations` | Type-based equivalent only | **New** `POST /api/v1/integrations/staybook/reservations`: StayBook's fields, specific mapped room |
| `GET /api/reservations/:id` | Equivalent by external id | **New** `GET …/staybook/reservations/{id}`: `{id}` = Frontdesk reservation id **or** StayBook booking reference |
| `POST /api/reservations/:id/cancel` | Equivalent (409 if repeated) | **New** `POST …/staybook/reservations/{id}/cancel`: repeating it returns 200 |
| *(updates: "dapat ma-sync din ang updates")* | `PATCH` by external id | **New** `PATCH …/staybook/reservations/{id}` with revision ordering (`updated_at`) |
| `GET /api/integration/bookings` (pull feed, StayBook) | – | **Not needed**: the push approach was chosen. Can be added later for reconciliation |

### Gaps that required changes

- **Room mapping.** No relation existed between StayBook and Frontdesk room ids. → `external_room_mappings` table + admin UI / API. Unmapped rooms are refused (`ROOM_NOT_MAPPED`); nothing is matched by name or number guesswork.
- **Room-level booking.** The existing Booking API books by type and picks a room. StayBook sells a specific room. → The adapter books exactly the mapped room (`ROOM_UNAVAILABLE` if it is taken). Policy: no silent move to another room.
- **StayBook-only data.** source booking id, hotel id, quoted nightly rate / total / currency, StayBook status, payment mode and revision timestamp. → `external_bookings` table, 1-to-1 with `reservations`. The `reservations` table is **unchanged**.
- **Authentication.** StayBook's cookie + CSRF flow is unsuitable between servers. → StayBook calls the Frontdesk with the existing **`BOOKING_API_KEY`** (StayBook is Member 1).
- **Out-of-order / repeated updates.** → `updated_at` is required on updates. Older revisions are refused (`STALE_UPDATE`); the same revision is a no-op.

---

## 2. Endpoints

Base URL: `https://<frontdesk-host>/api/v1/integrations/staybook`

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/rooms/available?check_in&check_out&guests[&hotel_id]` | `reservations:read` | Mapped rooms bookable for the stay (authoritative: includes walk-ins, in-house guests, maintenance) |
| POST | `/reservations` | `reservations:write` | Receive a new online booking |
| GET | `/reservations/{id}` | `reservations:read` | Acknowledgment / current Frontdesk state |
| PATCH | `/reservations/{id}` | `reservations:write` | A later StayBook revision |
| POST | `/reservations/{id}/cancel` | `reservations:write` | Cancellation |

`{id}` is the Frontdesk reservation id (digits) or the StayBook booking reference (e.g. `SB-EXAMPLE12345`). Only reservations that came from StayBook are visible; any other id returns 404.

Existing endpoints StayBook can also use with the same key: `GET /api/v1/integrations/booking/room-types` and `/booking/availability` (per type). It also receives the Booking webhooks (section 6).

### 2.1 Headers

```
X-Api-Key: <BOOKING_API_KEY>            (or  Authorization: Bearer <BOOKING_API_KEY>)
Content-Type: application/json
Idempotency-Key: <8–100 chars [A-Za-z0-9._:-]>      required on POST / PATCH
```

### 2.2 Field mapping

| Contract field | StayBook source | Frontdesk storage |
|---|---|---|
| `source_system` | constant `"STAYBOOK"` | `external_bookings.source_system` |
| `source_booking_id` | `reservation_id` | `external_bookings.source_booking_id` (unique) |
| `booking_reference` | `reference` (`SB-…`) | `reservations.external_reservation_id` + `booking_reference`, `external_bookings.booking_reference` (unique) |
| `hotel_id` | `hotel.id` | `external_bookings.hotel_id` (checked against `STAYBOOK_HOTEL_ID`) |
| `staybook_room_id` | `room_id` | `external_bookings.external_room_id` → `external_room_mappings` → `reservations.room_id` |
| `frontdesk_room_id` | optional (cross-check only) | must equal the mapped room, else 409 `ROOM_MAPPING_MISMATCH` |
| `guest.first_name/last_name/email/phone` | `first_name`, `last_name`, `email`, `phone` | `guests` (matched by email, or phone + last name, else created) |
| `check_in`, `check_out` | `check_in`, `check_out` (YYYY-MM-DD, Asia/Manila) | `reservations.check_in_date`, `check_out_date` |
| `guests` | `guests` | `reservations.num_guests` |
| `nights` | `nights` | validated = nights between the dates (not stored) |
| `nightly_rate`, `total_amount`, `currency` | `nightly_rate`, `total_amount`, `PHP` | `external_bookings` (**quote only**). Shown in the reservation notes; the bill uses Frontdesk rates |
| `booking_status` | `status` (`LOCAL_CONFIRMED` / `ADMIN_CONFIRMED`) | `external_bookings.booking_status`; the reservation is `CONFIRMED` for both |
| `payment_mode` | `"SIMULATED"` | `external_bookings.payment_mode`; `reservations.external_payment_status = UNPAID`; **no payment row** |
| `updated_at` | booking revision timestamp (ISO-8601) | `external_bookings.source_updated_at` (ms precision) |
| `idempotency_key` | per operation (see 4.2) | `Idempotency-Key` header → `integration_requests` |
| `frontdesk_reservation_id` | – (returned) | `reservations.id` |
| `sync_status` | – (returned) | `external_bookings.sync_status`: `ACKNOWLEDGED`, `UPDATED`, `CANCELLED` |

Not accepted: address, payment method, card digits, expiry or CVC. Unknown fields are discarded by the validator and never stored.

---

## 3. Request and response examples

### 3.1 Availability

```http
GET /api/v1/integrations/staybook/rooms/available?check_in=2026-12-10&check_out=2026-12-12&guests=2&hotel_id=1
X-Api-Key: <BOOKING_API_KEY>
```
```json
{ "success": true, "data": {
  "hotel_id": 1, "check_in": "2026-12-10", "check_out": "2026-12-12", "nights": 2, "guests": 2, "currency": "PHP",
  "rooms": [
    { "staybook_room_id": 1, "frontdesk_room_id": 3, "room_number": "204", "room_type": "Deluxe", "capacity": 2, "nightly_rate": 3500, "stay_total": 7000 }
  ],
  "unavailable_rooms": [
    { "staybook_room_id": 2, "frontdesk_room_id": 1, "room_number": "101", "room_type": "Standard", "capacity": 2, "nightly_rate": 2500, "reason": "NOT_AVAILABLE" }
  ] } }
```
`reason`: `NOT_AVAILABLE` (booked, occupied, or the type is sold out for a night), `CAPACITY_EXCEEDED`, `MAINTENANCE`, `OUT_OF_SERVICE`. StayBook should call this before confirming a booking, so a guest is never sold a room the hotel has given to a walk-in.

### 3.2 Create

```http
POST /api/v1/integrations/staybook/reservations
X-Api-Key: <BOOKING_API_KEY>
Idempotency-Key: staybook:create:SB-EXAMPLE12345:1796904000123:1
Content-Type: application/json

{
  "source_system": "STAYBOOK",
  "source_booking_id": "123",
  "booking_reference": "SB-EXAMPLE12345",
  "hotel_id": 1,
  "staybook_room_id": 1,
  "guest": { "first_name": "Sample", "last_name": "Guest", "email": "guest@example.com", "phone": "09123456789" },
  "check_in": "2026-12-10",
  "check_out": "2026-12-12",
  "guests": 2,
  "nights": 2,
  "nightly_rate": 3500.00,
  "total_amount": 7000.00,
  "currency": "PHP",
  "booking_status": "LOCAL_CONFIRMED",
  "payment_mode": "SIMULATED",
  "updated_at": "2026-12-01T08:00:00.123Z"
}
```
```json
HTTP/1.1 201 Created
{ "success": true, "data": {
  "frontdesk_reservation_id": 12, "reservation_code": "RSV-0012",
  "source_system": "STAYBOOK", "source_booking_id": 123, "booking_reference": "SB-EXAMPLE12345", "hotel_id": 1,
  "staybook_room_id": 1, "frontdesk_room_id": 3, "room_number": "204", "room_type": "Deluxe",
  "room_assignment": "AS_BOOKED", "assigned_staybook_room_id": 1,
  "check_in": "2026-12-10", "check_out": "2026-12-12", "guests": 2, "nights": 2,
  "nightly_rate": 3500, "total_amount": 7000, "currency": "PHP",
  "frontdesk_nightly_rate": 3500, "rate_matches_frontdesk": true,
  "booking_status": "LOCAL_CONFIRMED", "frontdesk_status": "CONFIRMED",
  "payment_mode": "SIMULATED", "payment_recorded": false,
  "sync_status": "ACKNOWLEDGED",
  "source_updated_at": "2026-12-01T08:00:00.123Z",
  "acknowledged_at": "2026-12-01T08:00:01.000Z", "last_synced_at": "2026-12-01T08:00:01.000Z" } }
```
Responses never include guest contact details. `room_assignment` is `AS_BOOKED`, `CHANGED_BY_FRONT_DESK` (a clerk moved the guest; `assigned_staybook_room_id` shows the current room, `null` if it is not mapped) or `PENDING`. A different quoted rate is accepted (`rate_matches_frontdesk: false`) and flagged in the reservation notes for the front desk.

### 3.3 Update (later revision)

Send only what changed, plus the new `updated_at`. A different `staybook_room_id` moves the booking to that mapped room (availability re-checked); otherwise a room chosen by the front desk is kept.

```http
PATCH /api/v1/integrations/staybook/reservations/SB-EXAMPLE12345
Idempotency-Key: staybook:update:SB-EXAMPLE12345:1796990400123:1

{ "check_out": "2026-12-13", "nights": 3, "total_amount": 10500, "booking_status": "ADMIN_CONFIRMED", "updated_at": "2026-12-02T08:00:00.123Z" }
```
Returns the same object as create, with `sync_status: "UPDATED"`. After check-in only status / quote / contact updates are accepted; date, guest-count or room changes return 409 `RESERVATION_NOT_MODIFIABLE`.

### 3.4 Cancel

```http
POST /api/v1/integrations/staybook/reservations/SB-EXAMPLE12345/cancel
Idempotency-Key: staybook:cancel:SB-EXAMPLE12345:1797076800123:1

{ "reason": "Guest cancelled online", "updated_at": "2026-12-03T08:00:00.123Z" }
```
Returns the object with `frontdesk_status: "CANCELLED"`, `booking_status: "CANCELLED"`, `sync_status: "CANCELLED"`, and the room is released. Cancelling again returns 200 with the same state. After check-in: 409 `RESERVATION_NOT_MODIFIABLE`. No refund is recorded; StayBook's refund is simulated.

### 3.5 Read

```http
GET /api/v1/integrations/staybook/reservations/12
GET /api/v1/integrations/staybook/reservations/SB-EXAMPLE12345
```

### 3.6 Errors

| HTTP | `code` | Meaning for StayBook | Retry? |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_JSON` | Client bug | No |
| 401 | `INVALID_API_KEY` | Wrong / missing key | No (fix config) |
| 403 | `INSUFFICIENT_SCOPE`, `HTTPS_REQUIRED` | Wrong key / plain HTTP in production | No |
| 404 | `RESERVATION_NOT_FOUND` | Not synced yet, or not a StayBook booking | No |
| 409 | `DUPLICATE_RESERVATION` | Already in the Frontdesk. **Treat as synced**: `error.details` is the existing reservation | No |
| 409 | `ROOM_UNAVAILABLE`, `NO_AVAILABILITY` | The mapped room is taken for those dates. Nothing stored | No (staff) |
| 409 | `ROOM_MAPPING_MISMATCH`, `ROOM_OUT_OF_SERVICE` | Room mapping / inventory problem at the Frontdesk | No (staff) |
| 409 | `RESERVATION_NOT_MODIFIABLE` | Checked in, checked out or cancelled | No |
| 409 | `STALE_UPDATE` | A newer revision was already applied | No |
| 409 | `REQUEST_IN_PROGRESS` | Same key still being processed | **Yes** |
| 422 | `VALIDATION_ERROR` | `error.details` per field (`check_in`, `nights`, `guests`, `currency`, …) | No |
| 422 | `ROOM_NOT_MAPPED`, `HOTEL_NOT_MANAGED` | Ask the Frontdesk admin to map the room / check `hotel_id` | No (until fixed) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body (client bug) | No |
| 429 | – | Rate limit (default 120/min); wait `Retry-After` | **Yes** |
| 5xx / network / timeout | – | Not stored by the Frontdesk | **Yes, same key** |

---

## 4. Synchronisation, retries and duplicates

### 4.1 Guarantees on the Frontdesk side

- **No duplicates.** A retry with the same `Idempotency-Key` and body replays the stored answer (`Idempotent-Replayed: true`). The same booking under a new key is refused with 409 `DUPLICATE_RESERVATION`: `source_booking_id` and `booking_reference` are unique. Simultaneous deliveries create exactly one reservation.
- **Atomic.** The reservation, room status, the `external_bookings` row and the event log entry are written in one transaction. A failure leaves nothing behind.
- **Ordered revisions.** `updated_at` older than the stored revision → `STALE_UPDATE`. Equal → no-op.
- **5xx answers are not stored**, so retrying with the same key is always safe.

### 4.2 What StayBook should do (reference client: [`docs/staybook/frontdeskClient.js`](staybook/frontdeskClient.js))

1. After saving or confirming a booking, call `createReservation(toFrontdeskReservation(row, { hotelId }))`.
2. Use **deterministic** keys: `staybook:<operation>:<reference>:<revision ms>:<generation>`. Automatic retries and queued retries then reuse the same key.
3. Retry network errors, timeouts, 429, 5xx and `REQUEST_IN_PROGRESS` with backoff. The client does this up to 4 times.
4. Record the outcome on the booking (`syncOutcome(result)`):
   - `SYNCED`: store `frontdesk_reservation_id`. A 409 `DUPLICATE_RESERVATION` also counts as synced.
   - `PENDING_RETRY`: the Frontdesk was unreachable. Keep the booking in a queue (e.g. a cron every few minutes) and call again with the **same generation**.
   - `REJECTED`: show `error_code` to StayBook staff. After fixing the cause (e.g. the Frontdesk admin maps the room), retry with **generation + 1**. The old key would only replay the refusal.
5. Send `PATCH` on every later change and `…/cancel` on cancellation, each with the booking's new `updated_at`.

---

## 5. Authentication configuration

**Frontdesk server (`.env`)**

```dotenv
BOOKING_API_KEY=<64 hex chars>          # the key StayBook sends
BOOKING_WEBHOOK_URL=https://onlinebooking.bongabonghealthup.online/<webhook path agreed with StayBook>
BOOKING_WEBHOOK_SECRET=<64 hex chars>   # StayBook verifies X-PMS-Signature with it
STAYBOOK_HOTEL_ID=1                     # StayBook's hotel.id for this property (optional; recommended)
# optional: require StayBook to HMAC-sign its writes (X-Timestamp + X-Signature, see INTEGRATIONS.md §2.4)
BOOKING_INBOUND_SECRET=
INTEGRATION_REQUIRE_HTTPS=true          # default in production
TRUST_PROXY=true                        # when behind Nginx / a TLS proxy
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Hand them to the StayBook developer over a private channel; never commit them.

**StayBook server (environment, never the browser)**

```dotenv
FRONTDESK_BASE_URL=https://<frontdesk-host>
FRONTDESK_API_KEY=<same value as BOOKING_API_KEY>
FRONTDESK_WEBHOOK_SECRET=<same value as BOOKING_WEBHOOK_SECRET>
FRONTDESK_HOTEL_ID=1
```

Security notes: keys are compared in constant time and logged only as "key presented: yes/no". Per-IP and per-system rate limits apply. Staff session cookies are **not** accepted on integration routes. Logs and stored responses contain ids, references and statuses only, never guest contact details or payment data.

---

## 6. Webhooks to StayBook (front-desk changes)

StayBook receives the existing Booking webhooks for its bookings (`external_reservation_id` = StayBook reference). It is never sent an echo of its own changes.

| Event | When |
|---|---|
| `ReservationUpdated` | The front desk changed the booking (e.g. moved the guest to another room) |
| `ReservationCancelled` | The front desk cancelled it |
| `GuestCheckedIn`, `GuestCheckedOut` | Arrival / departure (checkout includes a folio summary) |

Verify `X-PMS-Signature` (HMAC-SHA256 of `${X-PMS-Timestamp}.${raw body}` with `FRONTDESK_WEBHOOK_SECRET`), answer 2xx within 10 s, and de-duplicate on `event_id`. If StayBook is down, the Frontdesk retries with backoff (30 s, 1 min, 2 min … 1 h; 8 attempts); an admin can re-send from Admin Console → Integrations. After a webhook, `GET /reservations/{reference}` returns the full current state including `room_assignment` and `assigned_staybook_room_id`. Receiver example: [INTEGRATIONS.md §6](INTEGRATIONS.md#6-webhooks-pms--your-system).

---

## 7. Database changes (Frontdesk)

Both tables are **new**. `npm run migrate` creates them (it only adds missing tables and columns, never drops). No existing table or column was changed.

| Table | Purpose | Keys |
|---|---|---|
| `external_room_mappings` | `source_system`, `external_room_id` → `room_id` (+ `created_by`) | unique (`source_system`, `external_room_id`), unique (`source_system`, `room_id`); FK `room_id` → `rooms` RESTRICT |
| `external_bookings` | StayBook ids, hotel / room id, quoted `nightly_rate` / `total_amount` / `currency`, `booking_status`, `payment_mode`, `source_updated_at` DATETIME(3), `sync_status`, `last_synced_at` | unique `reservation_id` (FK → `reservations` RESTRICT), unique (`source_system`, `source_booking_id`), unique (`source_system`, `booking_reference`) |

StayBook bookings are otherwise ordinary reservations (`source = RESERVATION_SYSTEM`), so every Frontdesk screen, report and workflow handles them unchanged.

**Online Reservations notifications (§11)** add two more tables, also created by `npm run migrate` (additive only; no existing table or column is changed):

| Table | Purpose | Keys |
|---|---|---|
| `staff_notifications` | One notification for all staff: `category`, `title`, `message`, `reservation_id` (nullable), `external_booking_id` (nullable), `booking_reference`, `room_number`, `guest_name`, `details` (JSON: codes, dates, changes; never contact data), `created_at` | unique `dedupe_key` (one notification per event however often StayBook delivers it); FK `reservation_id` → `reservations`, `external_booking_id` → `external_bookings` (RESTRICT) |
| `staff_notification_reads` | Per-user read state (`notification_id`, `user_id`, `read_at`) | primary key (`notification_id`, `user_id`); FK → `staff_notifications`, `users` (RESTRICT) |

Notifications are never deleted. **The development database is not migrated automatically**: run `npm run migrate` when you are ready (the test suites create the tables in `FrontDesk_test`).

---

## 8. Remaining requirements for the StayBook developer

1. **Server-side Frontdesk client.** Copy `docs/staybook/frontdeskClient.js` (Node 18+) into StayBook's backend. Call it after `POST /api/bookings/confirm` succeeds, on every admin/guest update (`POST /api/admin/bookings/:id/update`, `PATCH` flows), and on cancellations (`/api/bookings/cancel`, `/api/admin/bookings/:id/cancel`).
2. **Store sync state per booking.** `frontdesk_reservation_id`, `integration_status` (`SYNCED` / `PENDING_RETRY` / `REJECTED`, replacing `NOT_CONNECTED`), last error code, sync generation, last attempt time.
3. **A revision timestamp.** Each booking needs an `updated_at` (or equivalent) that changes on every modification and is sent unchanged on retries.
4. **A retry job** for `PENDING_RETRY` bookings (e.g. every 5 minutes), plus a staff "retry sync" action for `REJECTED` ones (generation + 1).
5. **Check Frontdesk availability before confirming.** Call `GET /rooms/available` in the booking flow (or at least before confirm), and hide or refuse rooms the Frontdesk reports unavailable.
6. **Give the Frontdesk admin the room list.** StayBook `rooms.id` + room number for this hotel, so each one can be mapped in Admin Console → Integrations. Also give StayBook's `hotel.id` for `STAYBOOK_HOTEL_ID`.
7. **A webhook endpoint** (HTTPS) that verifies `X-PMS-Signature`, de-duplicates on `event_id`, and updates the booking. Send its URL to the Frontdesk admin.
8. **Keep payments simulated.** Never send card numbers, expiry or CVC; `payment_mode` stays `SIMULATED`. If real payments are added later, the contract must be extended first.
9. **Keep secrets server-side.** `FRONTDESK_API_KEY` and `FRONTDESK_WEBHOOK_SECRET` must not reach the browser or the repository.

---

## 9. Connecting the deployed systems

1. **Frontdesk deploy.** Pull this version, `npm install`, then `npm run migrate` (non-destructive; creates the two new tables). Restart.
2. **Secrets.** Generate `BOOKING_API_KEY` and `BOOKING_WEBHOOK_SECRET`, set them plus `STAYBOOK_HOTEL_ID`, `INTEGRATION_REQUIRE_HTTPS=true` and `TRUST_PROXY=true` (behind a TLS proxy) in the Frontdesk `.env`. Restart.
3. **Map rooms.** Admin Console → Integrations → *StayBook room mapping*: enter each Frontdesk room's StayBook room id.
4. **StayBook config.** The StayBook developer sets `FRONTDESK_BASE_URL`, `FRONTDESK_API_KEY`, `FRONTDESK_WEBHOOK_SECRET`, `FRONTDESK_HOTEL_ID` on Hostinger and deploys the client, sync job and webhook endpoint.
5. **Webhook URL.** Set `BOOKING_WEBHOOK_URL` on the Frontdesk to StayBook's HTTPS webhook endpoint. Restart.
6. **Smoke test** (a test booking far in the future):
   - `GET /rooms/available` from StayBook's server → the mapped rooms appear.
   - Book on StayBook → the reservation appears in Frontdesk → Reservations with the *Online* badge (booking reference and quote in its notes), room RESERVED; StayBook shows `SYNCED` + `RSV-…`.
   - Change the dates on StayBook → updated in Frontdesk.
   - Move the room at the front desk → StayBook receives `ReservationUpdated` (Admin Console → Integrations → Outbound webhooks shows SENT).
   - Cancel on StayBook → Frontdesk shows CANCELLED, room released.
7. **Monitor.** Admin Console → Integrations lists inbound requests (status codes) and outbound webhooks (with manual retry).

**Live status:** the integration has been tested only against a simulated StayBook (automated tests in `__tests__/integrations.staybook.test.js`). It has **not** been tested against the deployed StayBook at `onlinebooking.bongabonghealthup.online`, which does not implement the client side yet.

---

## 10. Tests

`npm test` runs `__tests__/integrations.staybook.test.js` against the real API and a MySQL test database (`FrontDesk_test`); StayBook is simulated. The suite covers:

- successful sync and invalid data
- invalid, mismatching and out-of-service room mapping, and a room taken at the desk
- duplicates: replay, key reuse, a new key, and concurrent deliveries
- updates (revision ordering, room move, conflicts) and cancellations (repeated, after check-in)
- authentication failures
- StayBook's webhook endpoint down → retry
- the reference client: Frontdesk unreachable, timeouts, lost answers, and reject → fix → retry
- local Frontdesk reservations unaffected

`__tests__/staybook.notifications.test.js` covers §11: the new-booking notification (guest, room, reference; no contact data); visibility for receptionists and administrators (401 anonymous, CSRF on writes); per-user unread counts, mark read and mark all read; the page's columns and every filter; reservation details and history; room protection (walk-in by room and by type refused for overlapping dates, adjacent stays allowed, room assignment refused, picker eligibility, holds endpoint); updated dates (old nights released, new nights protected, one notification per revision, stale revisions ignored, conflicting change refused); cancellation (room released, records kept, notified once, front-desk cancellations not announced); failed synchronisation (unmapped room, invalid data, unknown booking, webhook to StayBook failing on every attempt, admin view); duplicate deliveries (replay, new key, simultaneous); and unchanged front-desk workflows.

---

## 11. Online Reservations page, notifications and room protection

### 11.1 What existed (audit) and what was added

| Need | Before | Now |
|---|---|---|
| Receive / update / cancel StayBook bookings, no duplicates | Done (§2–§4) | **Unchanged.** Notifications are written inside the same functions and transactions |
| A StayBook room held for its dates | Done: a StayBook booking is a normal `CONFIRMED` reservation of the mapped room, and `assertBookable` / `findAvailableRooms` (`services/availabilityService.js`) refuse any overlapping booking, assignment, walk-in or room move under row locks | **Rules unchanged.** The refusal now names the online booking (§11.3); the room picker and the walk-in form show online holds |
| A list of online bookings for staff | Only an "Online" badge on Reservations | **Online reservations** page (`/front-desk/online-reservations`) |
| Telling staff about new / changed / cancelled bookings and sync problems | Nothing (refusals only in the admin request log) | Staff notifications: bell + dropdown, sidebar count, toast, dashboard card, admin "StayBook sync issues" card |

Nothing is copied: the page reads `external_bookings` joined with `reservations`, so there is still exactly one reservation per booking. Reservations from the older type-based Booking API (`/booking/reservations`) keep their "Online" badge on Reservations but are not listed on this page.

### 11.2 Notifications

| Category | When | Shown as |
|---|---|---|
| `ONLINE_RESERVATION_NEW` | StayBook booking accepted (POST `/reservations` → 201) | New online reservation |
| `ONLINE_RESERVATION_UPDATED` | A newer StayBook revision applied (PATCH). Lists what changed | Online reservation updated |
| `ONLINE_RESERVATION_CANCELLED` | Cancelled from StayBook (POST `…/cancel`) | Online reservation cancelled |
| `ROOM_CONFLICT` | StayBook's create / change refused because the room is taken (`ROOM_UNAVAILABLE`, `NO_AVAILABILITY`, `ROOM_OCCUPIED`, `ROOM_UNDER_MAINTENANCE`). Includes the booking that holds the room | Room conflict warning (red) |
| `SYNC_FAILED` | Any other refused StayBook write (`ROOM_NOT_MAPPED`, `HOTEL_NOT_MANAGED`, `VALIDATION_ERROR`, `RESERVATION_NOT_FOUND`, `RESERVATION_NOT_MODIFIABLE`, mapping problems), or a webhook to StayBook that failed after every retry | Synchronization failed (red) |

Each notification carries the guest name, room number and booking reference (plus the Frontdesk reservation id when there is one), never email, phone or payment data.

- **Exactly once.** Booking notifications are written in the booking's transaction with a unique key (`STAYBOOK:NEW:<booking>`, `…:UPDATED:<booking>:<revision>`, `…:CANCELLED:<booking>`). A replay with the same `Idempotency-Key` never reaches the code; the same booking under a new key is `DUPLICATE_RESERVATION`; the same revision again is a no-op. None of these notify twice. Refusals are keyed by the request's `Idempotency-Key`.
- **Not notified:** `DUPLICATE_RESERVATION` (already synced), `STALE_UPDATE` (older revision), `REQUEST_IN_PROGRESS`, authentication failures (admin request log only), and changes made at the front desk itself.
- **Who sees them:** every receptionist and administrator (room assignment is a receptionist task). Read state is **per staff member**: opening a notification, opening the reservation's details, viewing *Sync issues* or *Mark all read* clears it only for you.
- **Delivery is by polling, not real-time.** The application has no push channel. Every staff page asks `GET /api/v1/notifications/summary` every **30 seconds** while the tab is visible (and immediately when it becomes visible again), so a new booking appears within about 30 seconds. A toast announces notifications that arrive while a page is open.

### 11.3 Room protection

A StayBook booking holds **its room for its nights only**: `[check_in, check_out)`.

Example: Room 204 is booked online for 25 → 27 November (the nights of the 25th and 26th).

| Attempt at the front desk | Result |
|---|---|
| Walk-in in room 204, 26 → 28 Nov | **Refused** 409 `ROOM_UNAVAILABLE`: "Room 204 is reserved for an online StayBook guest (SB-…, RSV-0012) from 2026-11-25 to 2026-11-27. It cannot be given to another guest for overlapping dates." |
| Assign room 204 to another arriving guest for 24 → 26 Nov | **Refused**, same message. The room picker shows 204 greyed out as "Online booking SB-…" |
| Walk-in by type "Deluxe" when 204 is the only Deluxe room left for those nights | **Refused** 409 `NO_AVAILABILITY` (type capacity counts online bookings too) |
| Walk-in in room 204, 23 → 25 Nov (leaves on the arrival day) | **Allowed** |
| Walk-in in room 204, 27 → 29 Nov (arrives on the departure day) | **Allowed** |

The room's `RESERVED` status is only a label for the housekeeping board; availability is always computed from reservation dates, so an upcoming online booking never blocks the room for other dates. When StayBook changes the dates, the old nights are released and the new nights protected in the same transaction. When StayBook cancels, the reservation becomes `CANCELLED` (kept with its room and dates as history) and the room is free for those nights. Protection is enforced on the server under row locks; the picker and walk-in warnings exist so staff understand why a room is not offered.

`details.protected_by` on the 409 gives `source_system`, `booking_reference`, `reservation_code`, `room_number`, `check_in`, `check_out`. A clash with a front-desk reservation keeps the original message and has no details.

### 11.4 Screens

- **Online reservations** (sidebar, all staff; the count is your unread notifications, red when any are problems). Tabs: All, Upcoming arrivals, Arriving today, Cancelled, Sync issues. Filters: guest name, booking reference (`SB-…` or `RSV-…`), room, check-in, check-out, status. Columns: StayBook reference, Frontdesk code and reservation id, guest, room and type (plus the originally booked room if the front desk moved the guest), check-in, check-out, guests, status (and StayBook status), date and time received, synchronisation. Click a row for details: all of the above, quoted price, payment mode, and the history (received / changed / cancelled by StayBook, changes made at the desk and whether StayBook was told, notifications). "Open reservation" goes to the normal reservation page (room assignment, check-in…).
- **Bell** (top bar, every page): unread notifications plus restaurant purchases needing attention. Opens a dropdown with the latest notifications; clicking one marks it read and opens the reservation.
- **Reservation page**: a "StayBook online booking" card for StayBook reservations.
- **Dashboard**: an "Online reservations" card (arriving today, upcoming, received today, next arrivals, sync issues in the last 7 days).
- **Admin Console → Integrations** (administrators): the existing StayBook room mapping and configuration, plus **StayBook sync issues**: refused StayBook requests (status, code, message) and failed webhooks to StayBook with **Re-send**.

### 11.5 Browser testing

Use a development or staging database, never production. Run `npm run migrate` (it only adds the two tables), then `npm run dev`. Play StayBook from a terminal with the Booking API key from `.env`. Example (adjust the dates to a few days ahead and `staybook_room_id` to a room mapped in Admin Console → Integrations):

```bash
BASE=http://localhost:3000/api/v1/integrations/staybook
KEY=<BOOKING_API_KEY>
curl -s -X POST "$BASE/reservations" -H "X-Api-Key: $KEY" -H "Idempotency-Key: demo:create:SB-DEMO1:1" \
  -H "Content-Type: application/json" -d @booking.json
```

with `booking.json`:

```json
{ "source_system": "STAYBOOK", "source_booking_id": "9001", "booking_reference": "SB-DEMO1", "hotel_id": 1, "staybook_room_id": 1,
  "guest": { "first_name": "Ana", "last_name": "Reyes" }, "check_in": "2026-11-25", "check_out": "2026-11-27", "guests": 2, "nights": 2,
  "nightly_rate": 3500, "total_amount": 7000, "currency": "PHP", "booking_status": "LOCAL_CONFIRMED", "payment_mode": "SIMULATED",
  "updated_at": "2026-11-21T08:00:00.000Z" }
```

1. Sign in as a **receptionist** in one browser and an **administrator** in another. Within ~30 s both see the bell count and the "Online reservations" count rise, and a toast "New online reservation · Room …".
2. Open the bell: the notification shows guest, room and reference. Click it: the details panel opens and the count drops **for that user only** (the other browser still shows it).
3. Online reservations: try each filter and tab, open a row, then "Open reservation".
4. Room protection: Reservations → New reservation (Ctrl/Cmd + A) with overlapping dates and the same room type: the form warns "Reserved online for these dates: Room …". Create a reservation by type for overlapping dates and click "Assign room": the online room is listed greyed out ("Online booking SB-DEMO1") and cannot be chosen. A reservation whose stay ends on the online check-in date is offered the room normally.
5. Send the same `curl` again (same key): nothing new appears. With a new `Idempotency-Key`: 409 `DUPLICATE_RESERVATION`, still nothing new.
6. `PATCH $BASE/reservations/SB-DEMO1` with new dates, matching `nights` and a later `updated_at` → "Online reservation updated" listing the change; the old nights are free again.
7. `POST $BASE/reservations/SB-DEMO1/cancel` with `{"updated_at": "<later>"}` → "Online reservation cancelled"; the row stays under Cancelled and the room is offered for those dates.
8. Send a booking with an unmapped `staybook_room_id` (e.g. 999) → "Synchronization failed" (red) in the bell and under Sync issues; administrators also see it in Admin Console → Integrations → StayBook sync issues.
9. Book a room on dates already taken at the desk → "Room conflict warning" naming the reservation that holds the room.
