# Integration guide: connecting your system to the Frontdesk / PMS

This guide is for the members who build the other hotel systems. Your system stays a separate application. It talks to the Frontdesk / PMS only through the authenticated API and webhooks described here, and you never need access to the PMS database or code.

| Member | System | You call the PMS to… | The PMS calls you (webhooks) when… |
|---|---|---|---|
| 1 | Guest Booking System | create, change and cancel reservations; read room types and availability | a guest checks in or out; the front desk changes one of your bookings |
| 2 | **Frontdesk / PMS** (this system) | n/a | n/a |
| 3 | Housekeeping System | report cleaning started / completed; read the room board | a room is vacated (create a cleaning task); a room's status changes; a room is marked clean |
| 4 | Restaurant POS | notify a hotel guest's purchase for front-desk review ([POS_ORDERS.md](POS_ORDERS.md)); legacy: charge directly to the room | a guest checks in (room can be charged) or out (stop charging); a purchase was added to the folio or rejected |
| 5 | HR and Payroll | verify housekeeping job records | nothing (HR only reads) |

The PMS is the source of truth for reservations, room assignments, room status, check-in / check-out and the guest folio. Each system keeps owning its own data (bookings and payments online, cleaning staff and schedules, restaurant orders, employees and payroll).

---

## 1. Architecture at a glance

```
 Booking (M1) ──POST /booking/reservations──►┐
 POS (M4) ─────POST /pos/room-charges───────►│      Frontdesk / PMS (M2)
 Housekeeping (M3) ─POST /housekeeping/…────►│  /api/v1/integrations/*
 HR (M5) ──────GET  /hr/housekeeping-tasks──►┘  API key → scope → (signature) → idempotency → validation
                                                       │ one DB transaction:
                                                       │   business change + room status log
                                                       │   + integration_events row + webhook outbox rows
                                                       ▼
                                             outbox worker ──signed POST──► your webhook URL
                                             (retries with backoff; at-least-once)

 Housekeeping (M3) ──job logs (direct, not through the PMS)──► HR (M5)
```

- **Requests into the PMS** are synchronous REST calls with JSON bodies.
- **Events out of the PMS** are written in the same database transaction as the change that caused them (transactional outbox). An event is therefore never sent for a change that was rolled back, and never lost for one that was committed. A worker delivers them as signed HTTP POSTs and retries failures.
- **Housekeeping → HR job logs go directly from Housekeeping to HR.** The PMS does not relay them, because Housekeeping owns the employee, start-time and duration data. Relaying would duplicate that data in the PMS and tie the PMS to HR's format. What the PMS adds is an independent record of every cleaning it accepted, which HR can read to verify a job log (section 7). Completing a task is not attendance or approved overtime; HR decides that with its own rules.

---

## 2. Getting connected (all members)

1. **Ask the PMS administrator for your credentials.** You receive them over a private channel; never commit them or put them in frontend code.
   - Your **API key** (every system).
   - An **inbound signing secret**, if your requests must be signed. This is required for Housekeeping and optional for the other systems.
   - A **webhook secret**, if you receive webhooks (Booking, POS, Housekeeping).
2. **Give the administrator your webhook URL** (HTTPS in production), if you receive webhooks.
3. **Point your system at the base URL:** `https://<pms-host>/api/v1/integrations`.
4. **Test with Postman** (`docs/postman/HotelFrontDesk-PMS.postman_collection.json`): there is a folder for each member.

On the PMS server the administrator puts these values in `.env`:

```dotenv
BOOKING_API_KEY=…            BOOKING_WEBHOOK_URL=https://booking.example/webhooks/pms   BOOKING_WEBHOOK_SECRET=…
POS_API_KEY=…                POS_WEBHOOK_URL=https://pos.example/webhooks/pms           POS_WEBHOOK_SECRET=…
HOUSEKEEPING_API_KEY=…       HOUSEKEEPING_WEBHOOK_URL=https://hk.example/webhooks/pms   HOUSEKEEPING_WEBHOOK_SECRET=…
HOUSEKEEPING_INBOUND_SECRET=…   # REQUIRED: Housekeeping must sign its requests; without it its writes get 503 (except NODE_ENV=test)
HR_API_KEY=…
```

### 2.1 Authentication: who you are

Send your key on every request:

```
X-Api-Key: <your key>          (or)   Authorization: Bearer <your key>
```

Missing or unknown key: **401 `INVALID_API_KEY`**.

### 2.2 Authorization: what you may do

Each key carries only the permissions (scopes) of its system. Calling another system's endpoint with your key returns **403 `INSUFFICIENT_SCOPE`**.

| System | Scopes |
|---|---|
| BOOKING | `reservations:read`, `reservations:write` |
| POS | `folio:read`, `room_charges:write`, `pos_orders:write`, `pos_orders:read` |
| HOUSEKEEPING | `rooms:read`, `housekeeping:write` |
| HR | `housekeeping_tasks:read` |

### 2.3 Idempotency: required on every POST / PATCH

```
Idempotency-Key: <8–100 chars: letters, digits, . _ : - >      e.g. a UUID per logical operation
```

| Situation | Result |
|---|---|
| First request | Processed; the response is stored |
| Retry with the **same key and same body** (e.g. after a timeout) | The original response is returned again, with header `Idempotent-Replayed: true`. Nothing is processed twice |
| Same key, **different body** | 422 `IDEMPOTENCY_KEY_REUSED` |
| Same key while the first call is still running | 409 `REQUEST_IN_PROGRESS` (retry shortly) |
| 5xx response | Not stored, so it is safe to retry with the same key |

On top of that, every system's own reference is unique, so the same business operation is refused even under a new key: `external_reservation_id`, `external_transaction_id` and `external_task_id` return **409 `DUPLICATE_…`** with the existing record in `error.details`.

> Reuse the same Idempotency-Key when you retry. Use a new key for a new operation.

### 2.4 Signed requests (Housekeeping, and any system given an inbound secret)

```
X-Timestamp: <Unix seconds>
X-Signature: sha256=<hex HMAC-SHA256(inbound_secret, `${X-Timestamp}.${raw request body}`)>
```

- Sign the **exact bytes** you send as the body.
- Reads (GET) do not need a signature.
- Errors (all 401):
  - `SIGNATURE_REQUIRED`: headers missing.
  - `INVALID_SIGNATURE`: wrong secret, or the body changed after signing.
  - `SIGNATURE_EXPIRED`: timestamp more than 300 s from the server clock. This blocks replays of captured requests; keep your clock in sync (NTP).
- **Housekeeping signing is mandatory (fail closed).** If the PMS has no `HOUSEKEEPING_INBOUND_SECRET`, it does not fall back to accepting unsigned requests. Every Housekeeping write is refused with **503 `INBOUND_SIGNING_NOT_CONFIGURED`** until the administrator sets the secret. The PMS also logs an error at startup, and the Admin Console shows "Secret missing: writes refused". Reads (GET) still work. The only exception is the PMS's automated test environment (`NODE_ENV=test`). For other systems, signing applies only once they are given an inbound secret.

```js
import crypto from "crypto";
const body = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "sha256=" + crypto.createHmac("sha256", process.env.PMS_INBOUND_SECRET).update(`${ts}.${body}`).digest("hex");
await fetch(`${PMS}/api/v1/integrations/housekeeping/cleaning-completed`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Api-Key": process.env.PMS_API_KEY, "Idempotency-Key": crypto.randomUUID(), "X-Timestamp": ts, "X-Signature": sig },
  body,
});
```

### 2.5 Responses and errors

```json
{ "success": true,  "data": { … }, "meta": { … } }
{ "success": false, "error": { "code": "ROOM_MISMATCH", "message": "Room 101 does not belong to reservation RSV-0001.", "details": { … } } }
```

| HTTP | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_JSON` |
| 401 | `INVALID_API_KEY`, `SIGNATURE_REQUIRED`, `INVALID_SIGNATURE`, `SIGNATURE_EXPIRED` |
| 403 | `INSUFFICIENT_SCOPE`, `HTTPS_REQUIRED` |
| 404 | Unknown resource (`NOT_FOUND`, `RESERVATION_NOT_FOUND`, `ROOM_NOT_FOUND`, `NO_IN_HOUSE_GUEST`, `TASK_NOT_FOUND`) |
| 409 | A business rule refused the request; `code` says which (see each section) |
| 422 | `VALIDATION_ERROR` with per-field `details`, or `IDEMPOTENCY_KEY_REUSED` |
| 429 | Rate limit (default 120 requests / minute per system); wait `Retry-After` seconds |
| 503 | `INBOUND_SIGNING_NOT_CONFIGURED`: your writes must be signed but the PMS has no secret for you yet (section 2.4); retry later |
| 5xx | Unexpected; safe to retry with the same Idempotency-Key |

- **Field names** are `snake_case`.
- **Dates** are `YYYY-MM-DD` in the hotel's timezone (Asia/Manila).
- **Timestamps** are ISO-8601.
- **Money** is a number with up to 2 decimals, in `PHP`.
- **Privacy:** responses and webhooks contain references and statuses only, never guest contact details or ID data. The one exception is the booking you created yourself.

---

## 3. Member 1: Guest Booking System

> **StayBook (the Member 1 online booking app) sells specific rooms, not room types.** It uses the room-based contract under `/api/v1/integrations/staybook` with the same `BOOKING_API_KEY`: explicit StayBook-room → Frontdesk-room mapping, quoted price, StayBook status and revision. See **[STAYBOOK.md](STAYBOOK.md)**. The type-based `/booking` endpoints below remain available.

Base path `/booking`. Workflow:

1. `GET /room-types` once: the room types and their stable `room_type_id`.
2. `GET /availability` to show what can be booked.
3. `POST /reservations` when the guest books. The PMS does the following in one transaction:
   - validates the request;
   - checks availability for every night under row locks, so two simultaneous bookings for the last room can never both succeed;
   - finds the guest by email (or phone + last name) or creates them;
   - stores the reservation;
   - assigns a free room of that type when one exists, which makes the room **RESERVED**.
4. Store the returned `reservation_id`. It is the PMS id that the POS and the front desk use for this stay.
5. Changes and cancellations: `PATCH` / `POST …/cancel`, allowed while the reservation is still `CONFIRMED`.
6. Webhooks keep you in sync:
   - `GuestCheckedIn`, `GuestCheckedOut`;
   - `ReservationUpdated`, when the front desk changes your booking (e.g. a different room);
   - `ReservationCancelled`, when the front desk cancels your booking.

   You never receive an echo of a change you made yourself.

| Method | Path | Purpose |
|---|---|---|
| GET | `/booking/room-types` | Room types with `room_type_id`, room count, capacity, rates |
| GET | `/booking/availability?check_in_date&check_out_date[&room_type_id]` | Rooms still bookable per type for every night of the range |
| POST | `/booking/reservations` | Create a reservation |
| GET | `/booking/reservations/{external_reservation_id}` | Current state in the PMS |
| PATCH | `/booking/reservations/{external_reservation_id}` | Change dates, type, guests, guest contact, `payment_status`, `notes` |
| POST | `/booking/reservations/{external_reservation_id}/cancel` | Cancel (`{ "reason": "…" }`) |

**Create a reservation**

```http
POST /api/v1/integrations/booking/reservations
X-Api-Key: <BOOKING key>
Idempotency-Key: 3f6c1a2e-6a0b-4a51-9a0e-1c1d2f3a4b5c
Content-Type: application/json

{
  "external_reservation_id": "BOOK-10001",
  "guest": { "first_name": "John", "last_name": "Doe", "email": "john@example.com", "phone": "09123456789" },
  "room_type_id": 2,
  "check_in_date": "2026-12-01",
  "check_out_date": "2026-12-03",
  "number_of_guests": 2
}
```
```json
HTTP/1.1 201 Created
{ "success": true, "data": {
  "reservation_id": 1, "reservation_code": "RSV-0001", "external_reservation_id": "BOOK-10001", "booking_reference": null,
  "status": "CONFIRMED", "guest_id": 1, "room_type_id": 2, "room_type": "Deluxe",
  "room_assignment": "ASSIGNED",
  "room": { "room_id": 3, "room_number": "204", "floor": null, "room_type": "Deluxe", "status": "RESERVED" },
  "check_in_date": "2026-12-01", "check_out_date": "2026-12-03", "number_of_guests": 2,
  "payment_status": null, "cancelled_at": null, "last_synced_at": "2026-11-16T13:20:07.000Z" } }
```

| Field | Rules |
|---|---|
| `external_reservation_id` | Required, ≤ 100 chars, `[A-Za-z0-9._:-]`, unique in your system |
| `guest.first_name`, `guest.last_name` | Required. `email` and `phone` are optional, but help the PMS recognise returning guests |
| `room_type_id` | Required (from `/room-types`). `room_type` (the name) is accepted instead |
| `check_in_date`, `check_out_date` | `YYYY-MM-DD`. Check-in can't be in the past, check-out must be after check-in, and a stay is at most 60 nights |
| `number_of_guests` | 1–20, within the room type's capacity |
| `booking_reference`, `payment_status` (`UNPAID`, `DEPOSIT_PAID`, `PREPAID`, `REFUNDED`), `notes` | Optional. They are shown to the front desk; the guest still settles the final bill at checkout |

`room_assignment` is `ASSIGNED`, or `PENDING` when the type has availability but no single room is free for every night. In that case the front desk assigns a room later, and you receive `ReservationUpdated`.

**Errors**

| HTTP | `code` | When |
|---|---|---|
| 409 | `NO_AVAILABILITY` | Sold out for at least one night. Nothing is stored |
| 409 | `DUPLICATE_RESERVATION` | `external_reservation_id` already exists (`details` = the existing reservation) |
| 409 | `RESERVATION_NOT_MODIFIABLE` | PATCH or cancel after check-in, check-out or cancellation |
| 409 | `NO_AVAILABILITY` (on PATCH) | The new dates / type / guest count are sold out; the reservation is left unchanged |
| 422 | `VALIDATION_ERROR` | e.g. `{ "guest": { "first_name": "This field is required." }, "number_of_guests": "Must be at least 1." }`, unknown `room_type_id` |

```json
HTTP/1.1 409 Conflict
{ "success": false, "error": { "code": "NO_AVAILABILITY", "message": "No Deluxe rooms are available for 2026-12-01 to 2026-12-03 (fully booked on 2026-12-01)." } }
```

**Change and cancel**

```http
PATCH /api/v1/integrations/booking/reservations/BOOK-10001        { "check_in_date": "2026-12-02", "check_out_date": "2026-12-04", "payment_status": "PREPAID" }
POST  /api/v1/integrations/booking/reservations/BOOK-10001/cancel { "reason": "Guest cancelled online" }
```

Both return the same object as the create call. On a date change, the assigned room is kept if it is still free; otherwise another free room of the type is assigned. A cancellation releases the room (`RESERVED` → `AVAILABLE` when nothing else is assigned to it).

---

## 4. Member 4: Restaurant POS (charge to room)

> **New integrations: use `POST /pos/orders` — see [POS_ORDERS.md](POS_ORDERS.md).** The POS notifies each completed hotel-guest purchase; the front desk verifies the guest and adds it to the folio (or rejects it); the POS receives `PosOrderReviewed`. The direct `POST /pos/room-charges` flow below is **deprecated** (responses carry `Deprecation: true`) but still works unchanged for existing clients. An order is never billed twice across the two paths.

Base path `/pos`. Legacy direct-posting workflow:

1. The guest orders and asks to *charge to room*.
2. The cashier enters the room number. Call `GET /pos/in-house?room_number=204`. The response gives `reservation_id`, a masked name (`J. Doe`) and whether the folio is open. You also get these from the `GuestCheckedIn` webhook.
3. `POST /pos/room-charges`. The PMS checks, under row locks:
   - the reservation exists and is **checked in** (not future, cancelled or checked out);
   - the room belongs to that reservation;
   - the guest name matches (if you send it);
   - the currency is PHP and the items add up to the amount;
   - the folio is still open;
   - the transaction was never posted before.
4. The charge is written to the **Guest Folio** and is billed automatically at checkout.
5. Once the front desk confirms the final bill (checkout in progress), the folio closes. New charges get 409 `FOLIO_CLOSED` and must be paid at the restaurant. Corrections to posted charges are made by the front desk as bill adjustments.

| Method | Path | Purpose |
|---|---|---|
| GET | `/pos/in-house?room_number=` | Who is in the room (masked), `reservation_id`, `folio_open` |
| POST | `/pos/room-charges` | Post a charge |
| GET | `/pos/room-charges/{external_transaction_id}` | Check whether a charge was recorded |

```http
POST /api/v1/integrations/pos/room-charges
X-Api-Key: <POS key>
Idempotency-Key: pos-terminal-3-txn-10001
Content-Type: application/json

{
  "external_transaction_id": "POS-10001",
  "room_number": "204",
  "guest_name": "John Doe",
  "reservation_id": 1,
  "amount": 850.00,
  "currency": "PHP",
  "description": "Restaurant Order",
  "items": [
    { "name": "Chicken Adobo", "quantity": 2, "unit_price": 250.00 },
    { "name": "Iced Tea", "quantity": 2, "unit_price": 175.00 }
  ],
  "transaction_date": "2026-12-02T13:00:00Z"
}
```
```json
HTTP/1.1 201 Created
{ "success": true, "data": {
  "charge_id": 1, "external_transaction_id": "POS-10001", "status": "POSTED",
  "reservation_id": 1, "stay_id": 1, "room_number": "204", "category": "FOOD",
  "description": "Restaurant Order", "amount": 850, "currency": "PHP",
  "items": [ { "name": "Chicken Adobo", "quantity": 2, "unit_price": 250 }, { "name": "Iced Tea", "quantity": 2, "unit_price": 175 } ],
  "transaction_date": "2026-12-02T13:00:00.000Z", "posted_at": "2026-12-02T13:00:02.000Z" } }
```

| Field | Rules |
|---|---|
| `external_transaction_id` | Required, unique per POS transaction, `[A-Za-z0-9._:-]` |
| `reservation_id`, `room_number` | Required; the room must be the reservation's current room |
| `guest_name` | Optional cross-check. "John Doe", "Doe, John" and "J. Doe" all match; the last name must match |
| `amount` | > 0, 2 decimals; must equal Σ `quantity × unit_price` when `items` are sent |
| `currency` | Required; must be `PHP` |
| `category` | Optional: `FOOD` (default), `BEVERAGE` (restaurant charges), `MINIBAR`, `LAUNDRY`, `SPA`, `SERVICE`, `OTHER` (other charges) |
| `transaction_date` | Required ISO-8601, not in the future |
| `outlet` | Optional, e.g. "Lobby Restaurant" |

**Errors**

| HTTP | `code` | When |
|---|---|---|
| 404 | `RESERVATION_NOT_FOUND` / `NO_IN_HOUSE_GUEST` | Unknown reservation / empty room |
| 409 | `RESERVATION_NOT_ACTIVE` | Not checked in yet, or already checked out / cancelled |
| 409 | `ROOM_MISMATCH` | `room_number` is not the reservation's room |
| 409 | `GUEST_MISMATCH` | `guest_name` does not match the registered guest |
| 409 | `FOLIO_CLOSED` | The final bill is already confirmed |
| 409 | `DUPLICATE_TRANSACTION` | Already posted (`details` = the existing charge) |
| 422 | `VALIDATION_ERROR` | Wrong currency, items not adding up, amount ≤ 0, future date, missing fields |

---

## 5. Member 3: Housekeeping System

Base path `/housekeeping`. **Writes must be signed** (section 2.4). The PMS refuses unsigned writes and, without `HOUSEKEEPING_INBOUND_SECRET`, refuses all writes.

> **RoomCare: unverified assumption.** The PMS treats RoomCare as this Housekeeping System. RoomCare would use these endpoints, the Housekeeping API key and inbound secret, and the Housekeeping webhooks. **Member 3 has not confirmed this.** Nothing has been renamed and no separate RoomCare credentials exist. See [ROOM_SYNC.md](ROOM_SYNC.md).

Workflow:

1. A guest checks out (or moves rooms). The room becomes **DIRTY** and you receive a **`RoomVacated`** webhook. Create a cleaning task in your own application. Staff, assignments, schedules and progress stay in your system.
2. *(Optional)* `POST /cleaning-tasks` tells the PMS your `external_task_id` for that room, so the front desk can see the task. The room stays DIRTY.
3. `POST /cleaning-started` when a housekeeper starts: room **DIRTY → CLEANING**.
4. `POST /cleaning-completed` when the room is cleaned and inspected: room **→ AVAILABLE**. It becomes **RESERVED** instead when a confirmed reservation is already assigned to the room. The PMS:
   - records the completion (task id, employee id, time, remarks);
   - logs the status change;
   - publishes **`RoomCleaned`**.

   If you never reported the start, the PMS records DIRTY → CLEANING → AVAILABLE in one step.
5. Send your job logs (employee, times, minutes) **directly to HR**, not to the PMS.

| Method | Path | Purpose |
|---|---|---|
| GET | `/housekeeping/rooms[?status=DIRTY]` | Room board: status, last cleaned, open task |
| GET | `/housekeeping/rooms/{room_number}` | One room |
| POST | `/housekeeping/cleaning-tasks` | *(optional)* register your task for a DIRTY room |
| POST | `/housekeeping/cleaning-started` | DIRTY → CLEANING |
| POST | `/housekeeping/cleaning-completed` | → AVAILABLE / RESERVED |
| POST | `/housekeeping/cleaning-status` | one callback for `status` = `PENDING` / `IN_PROGRESS` / `COMPLETED` (same rules as the three above; intended for RoomCare, see [Cleaning-status callback](#cleaning-status-callback) below) |

```http
POST /api/v1/integrations/housekeeping/cleaning-completed
X-Api-Key: <HOUSEKEEPING key>
Idempotency-Key: hk-10001-completed
X-Timestamp: 1796295600
X-Signature: sha256=…
Content-Type: application/json

{
  "external_task_id": "HK-10001",
  "room_id": 3,
  "room_number": "204",
  "status": "COMPLETED",
  "completed_by": "EMP-001",
  "completed_at": "2026-12-03T12:30:00Z",
  "remarks": "Room cleaned and inspected"
}
```
```json
HTTP/1.1 200 OK
{ "success": true, "data": {
  "external_task_id": "HK-10001", "task_status": "COMPLETED",
  "room_id": 3, "room_number": "204", "room_status": "AVAILABLE", "previous_room_status": "CLEANING",
  "stay_id": 1, "source_event_id": "EVT-000010",
  "started_at": "2026-12-03T11:30:00.000Z", "started_by": "EMP-001",
  "completed_at": "2026-12-03T12:30:00.000Z", "completed_by": "EMP-001",
  "remarks": "Room cleaned and inspected", "recorded_at": "2026-12-03T12:30:01.000Z" } }
```

```http
POST /api/v1/integrations/housekeeping/cleaning-started
{ "external_task_id": "HK-10001", "room_number": "204", "started_by": "EMP-001", "started_at": "2026-12-03T11:30:00Z" }

POST /api/v1/integrations/housekeeping/cleaning-tasks
{ "external_task_id": "HK-10001", "room_number": "204", "event_id": "EVT-000010" }
```

| Field | Rules |
|---|---|
| `external_task_id` | Required, your task id, unique; one task belongs to one room |
| `room_id` / `room_number` | At least one; if you send both they must name the same room |
| `event_id` | Optional: the `RoomVacated` event this task answers (links the task to the stay). Defaults to the room's latest one |
| `status` | `COMPLETED` (cleaning-completed, required); `PENDING` / `IN_PROGRESS` / `COMPLETED` (cleaning-status, required) |
| `completed_by` / `started_by` | Your employee id (≤ 60 chars) |
| `completed_at` (required) / `started_at` (optional, default now) | ISO-8601, not in the future; completion not before the start |

**Errors**

| HTTP | `code` | When |
|---|---|---|
| 404 | `ROOM_NOT_FOUND` | Unknown room |
| 409 | `ROOM_MISMATCH` | `room_id` and `room_number` disagree |
| 409 | `ROOM_NOT_AWAITING_CLEANING` | Room is not waiting for cleaning (e.g. still OCCUPIED, already AVAILABLE, or under MAINTENANCE after it was already cleaned); `details.room_status` |
| 409 | `DUPLICATE_CLEANING_COMPLETION` | This task was already completed (`details` = the stored completion) |
| 409 | `TASK_ALREADY_STARTED`, `DUPLICATE_TASK`, `TASK_ROOM_MISMATCH` | Repeated start / registration, or the task id belongs to another room |
| 409 | `TASK_SUPERSEDED` | The front desk marked the room clean manually first (you also received `RoomCleaned` with `origin: "FRONT_DESK"`) |
| 401 | `SIGNATURE_*` | See section 2.4 |
| 503 | `INBOUND_SIGNING_NOT_CONFIGURED` | The PMS has no `HOUSEKEEPING_INBOUND_SECRET`; nothing was changed. Retry later |

> **The front desk fallback.** If your system cannot report a cleaning (e.g. it is down), the front desk can mark the room clean. The room becomes ready, any open task for it becomes `SUPERSEDED`, and you receive `RoomCleaned` with `origin: "FRONT_DESK"` so you can close your task.

> **Rooms under maintenance.** If a room goes into MAINTENANCE while it is DIRTY or CLEANING, it **still needs cleaning**. The administrator cannot make it AVAILABLE until a cleaning is recorded (`409 ROOM_NEEDS_CLEANING`). A room with an open cleaning task cannot become AVAILABLE either. You may keep reporting that room's task while it is under maintenance (`PENDING` / `IN_PROGRESS` / `COMPLETED`). The PMS records it and the room **stays MAINTENANCE**. A completion clears the cleaning requirement, and `RoomCleaned` is published with `room_status: "MAINTENANCE"`. The administrator then ends maintenance (→ AVAILABLE / RESERVED). Alternatively, the administrator returns the room as DIRTY and you clean it as usual. Open tasks are never closed automatically. Only your verified completion, or the front desk's explicit "Mark clean", closes them.

### Cleaning-status callback

`POST /api/v1/integrations/housekeeping/cleaning-status` reports every change of one cleaning task. It is intended for RoomCare, on the unverified assumption that RoomCare is this Housekeeping System. It applies exactly the rules of `/cleaning-tasks`, `/cleaning-started` and `/cleaning-completed`.

**Authentication (all required on every call):**

| Header | Value |
|---|---|
| `X-Api-Key` (or `Authorization: Bearer …`) | The Housekeeping API key (`HOUSEKEEPING_API_KEY` on the PMS). The key must hold the `housekeeping:write` scope; the Housekeeping key does. |
| `Idempotency-Key` | 8–100 characters (`A–Z a–z 0–9 . _ : -`). Reuse it when you retry the same call |
| `X-Timestamp` | Unix seconds, within ±300 s of the PMS clock |
| `X-Signature` | `sha256=` + hex HMAC-SHA256(`HOUSEKEEPING_INBOUND_SECRET`, `` `${X-Timestamp}.${raw body}` ``) (section 2.4) |

Unsigned or wrongly signed calls are refused with `401 SIGNATURE_REQUIRED` / `INVALID_SIGNATURE` / `SIGNATURE_EXPIRED`. If the PMS has no inbound secret configured, every call is refused with `503 INBOUND_SIGNING_NOT_CONFIGURED`. Production also requires HTTPS (`403 HTTPS_REQUIRED`).

**Supported identifiers and fields:**

| Field | Required | Rules |
|---|---|---|
| `status` | always | `PENDING`, `IN_PROGRESS` or `COMPLETED` (case-insensitive). Anything else gets `422 VALIDATION_ERROR` |
| `external_task_id` | always | Your task id, ≤ 100 chars, `A–Z a–z 0–9 . _ : -`. Unique across all rooms, and one task belongs to one room |
| `room_id` | one of `room_id` / `room_number` | The **Frontdesk** room id (integer ≥ 1), as sent in `RoomVacated.room_id` |
| `room_number` | one of `room_id` / `room_number` | The Frontdesk room number (≤ 10 chars). If you send both, they must name the same room (`409 ROOM_MISMATCH`) |
| `event_id` | no | The `RoomVacated` `event_id` this task answers (≤ 30 chars). Defaults to the room's latest one |
| `assigned_to` | no (`PENDING`) | Your employee id (≤ 60 chars) |
| `started_by` / `started_at` | `started_by` required for `IN_PROGRESS` | Employee id. ISO-8601 timestamp, not in the future, defaults to now |
| `completed_by` / `completed_at` | both required for `COMPLETED` | Employee id. ISO-8601 timestamp, not in the future, not before `started_at` |
| `remarks` | no | ≤ 500 chars |

`roomcare_room_id` is **not** an accepted identifier. It is sent *to* you in webhooks, but callbacks must name the room with the Frontdesk `room_id` or `room_number`. Unknown fields are ignored.

**Answer:** `PENDING` → `201`; `IN_PROGRESS` / `COMPLETED` → `200`. The body is the task as shown above, plus `cleaning_status`. The errors are those of the three endpoints (table above). A repeat with the same Idempotency-Key replays the first answer. A second completion of the same task under a new key gets `409 DUPLICATE_CLEANING_COMPLETION`.

---

## 6. Webhooks (PMS → your system)

**Delivery**
- `POST <your URL>` with a JSON body. Answer **2xx** within 10 s; process the event asynchronously if it takes longer.
- On failure, the PMS retries with exponential backoff (30 s, 1 min, 2 min … up to 1 h) up to 8 attempts, then marks the delivery FAILED. An administrator can re-send it from Admin Console → Integrations.
- Delivery is **at-least-once**. The same event can arrive twice, for example after a timeout or an admin re-send. **De-duplicate on `event_id`**, which is identical on every delivery and for every receiver of the same event.
- Order is per event creation, but don't rely on strict ordering across retries: use `occurred_at` and the status fields.

**Headers**

```
X-PMS-Event: RoomVacated
X-PMS-Event-Id: EVT-000010        (same as body.event_id)
X-PMS-Delivery: 8                 (delivery row id — differs per receiver)
X-PMS-Timestamp: 1796295600
X-PMS-Signature: sha256=<hex HMAC-SHA256(webhook_secret, `${X-PMS-Timestamp}.${raw body}`)>
```

**Verify every webhook** before trusting it:

```js
import crypto from "crypto";
app.post("/webhooks/pms", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  const ts = req.get("X-PMS-Timestamp");
  const expected = "sha256=" + crypto.createHmac("sha256", process.env.PMS_WEBHOOK_SECRET).update(`${ts}.${raw}`).digest("hex");
  const given = req.get("X-PMS-Signature") || "";
  const valid = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  if (!valid || !fresh) return res.sendStatus(401);
  const event = JSON.parse(raw);
  if (alreadyProcessed(event.event_id)) return res.sendStatus(200); // duplicate delivery
  queue(event);
  res.sendStatus(200);
});
```

**Body**: flat JSON. `event`, `event_id` and `occurred_at` appear alongside the event fields. Key order may vary.

| Event | Sent to | Fields |
|---|---|---|
| `GuestCheckedIn` | Booking (its bookings only), POS | `reservation_id`, `reservation_code`, `external_reservation_id`, `source` (`BOOKING` / `FRONT_DESK`), `status`, `guest_id`, `guest_display_name`, `room_id`, `room_number`, `room_type`, `stay_id`, `check_in_date`, `check_out_date`, `checked_in_at`, `number_of_guests`, `origin` |
| `GuestCheckedOut` | Booking (its bookings only), POS | as above + `checked_out_at` + `folio { currency, room_charges, restaurant_charges, other_charges, adjustments, total_charges, payments, balance }` |
| `ReservationUpdated` / `ReservationCancelled` | Booking (its bookings, changes made by the front desk) | reservation fields (as above, without stay fields) |
| `RoomVacated` | Housekeeping | `reservation_id`, `reservation_code`, `stay_id`, `room_id`, `room_number`, `room_type`, `guest_id`, `checkout_time`, `reason` (`CHECKOUT` / `ROOM_MOVE`), `room_status` (`DIRTY`), `cleaning_status` (`PENDING`), `message` (text for housekeeping staff), `roomcare_room_id`¹ |
| `RoomStatusChanged` | Housekeeping | `room_id`, `room_number`, `from_status`, `to_status`, `reason`, `source`, `reference`, `roomcare_room_id`¹ |
| `RoomCleaned` | Housekeeping | `room_id`, `room_number`, `room_status` (`AVAILABLE` / `RESERVED`, or `MAINTENANCE` when the cleaning was recorded during maintenance), `external_task_id`, `completed_by`, `completed_at`, `origin` (`HOUSEKEEPING` / `FRONT_DESK`), `roomcare_room_id`¹ |
| `ReservationCreated`, `RoomChargePosted`, `GuestFolioUpdated`, `CleaningTaskCreated`, `CleaningStarted`, `CleaningCompleted`, `RoomCreated`, `RoomUpdated`, `RoomArchived`, `RoomRestored` | nobody by default; recorded in the PMS event log (room catalogue events drive room sync, [ROOM_SYNC.md](ROOM_SYNC.md)) | |

¹ `roomcare_room_id`: RoomCare's own id for the room (string), or `null` until room sync has mapped the room ([ROOM_SYNC.md](ROOM_SYNC.md)). It is added to **every** webhook the Housekeeping target receives for a room (`RoomVacated`, `RoomStatusChanged`, `RoomCleaned`), and is not sent to any other system. It is informational: callbacks must still identify the room by `room_id` / `room_number`. It is sent on the Housekeeping target because RoomCare is assumed to be the Housekeeping System. That assumption is **unverified** and awaits Member 3's confirmation.

A system can be subscribed to a different set of events with `<SYSTEM>_WEBHOOK_EVENTS=GuestCheckedIn,RoomStatusChanged,…`.

**Example: `RoomVacated`**

```json
{
  "event": "RoomVacated",
  "event_id": "EVT-000010",
  "occurred_at": "2026-12-03T11:00:00.120Z",
  "reservation_id": 1,
  "reservation_code": "RSV-0001",
  "stay_id": 1,
  "room_id": 3,
  "room_number": "204",
  "room_type": "Deluxe",
  "guest_id": 1,
  "checkout_time": "2026-12-03T11:00:00.000Z",
  "reason": "CHECKOUT"
}
```

**Example: `GuestCheckedOut`** (to Booking and POS)

```json
{
  "event": "GuestCheckedOut", "event_id": "EVT-000009", "occurred_at": "2026-12-03T11:00:00.100Z", "origin": "PMS",
  "reservation_id": 1, "reservation_code": "RSV-0001", "external_reservation_id": "BOOK-10001", "booking_reference": null,
  "source": "BOOKING", "status": "CHECKED_OUT", "guest_id": 1, "guest_display_name": "J. Doe",
  "room_id": 3, "room_number": "204", "room_type": "Deluxe", "stay_id": 1,
  "check_in_date": "2026-12-01", "check_out_date": "2026-12-03", "number_of_guests": 2,
  "checked_in_at": "2026-12-01T06:12:00.000Z", "checked_out_at": "2026-12-03T11:00:00.000Z",
  "folio": { "currency": "PHP", "room_charges": 7000, "restaurant_charges": 850, "other_charges": 0, "adjustments": 0, "total_charges": 7850, "payments": 7850, "balance": 0 }
}
```

---

## 7. Member 5: HR and Payroll

Base path `/hr`, **read-only**. Housekeeping sends you its job logs directly (for example `POST <your HR API>/housekeeping-logs` with `external_log_id`, `employee_id`, `task_id`, `started_at`, `completed_at`, `total_minutes`, `status`). Before you credit the work, you can check that the PMS really recorded that cleaning:

| Method | Path | Purpose |
|---|---|---|
| GET | `/hr/housekeeping-tasks?from=YYYY-MM-DD&to=YYYY-MM-DD[&employee_id=][&status=]` | Completed tasks in a date range (≤ 31 days) |
| GET | `/hr/housekeeping-tasks/{task_id}` | One task (404 `TASK_NOT_FOUND` if the PMS never accepted it) |

```json
GET /api/v1/integrations/hr/housekeeping-tasks/HK-10001
{ "success": true, "data": {
  "external_task_id": "HK-10001", "task_status": "COMPLETED", "room_id": 3, "room_number": "204",
  "started_at": "2026-12-03T11:30:00.000Z", "started_by": "EMP-001",
  "completed_at": "2026-12-03T12:30:00.000Z", "completed_by": "EMP-001",
  "duration_minutes": 60, "remarks": "Room cleaned and inspected", "recorded_at": "2026-12-03T12:30:01.000Z" } }
```

A suggested check: `task_status = COMPLETED`, the same room, `completed_by = employee_id`, and `duration_minutes` close to `total_minutes`. Attendance, work hours, overtime approval, performance and payroll are decided entirely by HR's own rules. The PMS stores no employee data beyond the id Housekeeping reported.

---

## 8. Room status lifecycle (reference)

```
            reservation assigned               check-in
 AVAILABLE ───────────────────────► RESERVED ───────────► OCCUPIED
     ▲  ◄─────────────────────────────┘ released (cancel /    │ checkout / room move
     │                                   reassign)            ▼  (RoomVacated)
     │  cleaning completed                                  DIRTY
     └─────────── CLEANING ◄──────────────────────────────────┘
       (or RESERVED if a     cleaning started
        reservation is
        assigned)

 MAINTENANCE: from AVAILABLE, RESERVED, DIRTY or CLEANING (never while OCCUPIED);
              back to AVAILABLE / RESERVED (ready) or DIRTY (needs cleaning)
```

| From | Allowed to |
|---|---|
| AVAILABLE | RESERVED, OCCUPIED, MAINTENANCE |
| RESERVED | AVAILABLE, OCCUPIED, MAINTENANCE |
| OCCUPIED | DIRTY |
| DIRTY | CLEANING, MAINTENANCE |
| CLEANING | AVAILABLE, RESERVED, DIRTY, MAINTENANCE |
| MAINTENANCE | AVAILABLE, RESERVED, DIRTY |

- Any other change is refused (409 `INVALID_ROOM_STATUS_TRANSITION`).
- Every change is logged (from, to, reason, source system or staff member, external reference) and published as `RoomStatusChanged`.
- A room never goes from OCCUPIED straight to AVAILABLE: after checkout it waits for housekeeping.
- **Maintenance does not skip cleaning.** A room that enters MAINTENANCE from DIRTY or CLEANING keeps its cleaning requirement. MAINTENANCE → AVAILABLE / RESERVED is refused (409 `ROOM_NEEDS_CLEANING`) while that requirement is pending or any cleaning task for the room is open. Only a verified housekeeping completion or the front desk's "Mark clean" clears it (section 5). A clean room that enters and leaves maintenance is unaffected.
- **Room status is not availability.** Whether a room can be booked for given dates is always computed from reservation dates. A room RESERVED for December can still be sold for tonight.
- **Reservation status** (CONFIRMED → CHECKED_IN → CHECKED_OUT, or CANCELLED) is managed separately from room status.

---

## 9. Testing your integration

- **Without the PMS team:** import the Postman collection. Set `baseUrl` and your key (plus `housekeepingInboundSecret` for Housekeeping; the folder signs requests automatically). Run your folder.
- **Local PMS:** `npm install && cp .env.example .env`, set your key(s) in `.env`, `npm run migrate -- --seed`, `npm start`. For webhooks to reach a local receiver, set `<SYSTEM>_WEBHOOK_URL=http://localhost:<port>/…`.
- **PMS automated tests** (`npm test`): simulated versions of all four systems drive the real API, including webhook receivers that verify signatures. You don't need any other member's application running. See `__tests__/README.md`.

Checklist before going live:
- [ ] Your key and secrets live in your server's environment, not in code or the browser.
- [ ] Every POST / PATCH sends an Idempotency-Key, and retries reuse it.
- [ ] You handle 409 codes as business answers (show them to staff) and only retry 429 / 5xx / network errors.
- [ ] (Housekeeping) Requests are signed and your clock is NTP-synced.
- [ ] (Webhook receivers) You verify `X-PMS-Signature`, answer 2xx quickly and de-duplicate on `event_id`.
- [ ] Production uses HTTPS only (the PMS refuses plain HTTP when `INTEGRATION_REQUIRE_HTTPS=true`, the production default).
