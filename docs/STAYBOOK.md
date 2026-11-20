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
