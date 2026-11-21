# FrontDesk External System API Handoff: POS, OnlineBooking (StayBook), RoomCare

**Audience:** the developers of the Restaurant POS, OnlineBooking (StayBook) and RoomCare systems.
**Source of truth:** the FrontDesk source code at commit `9c6e7c9` (branch `feature/pos-order-review`). Every path, field and error code below was checked against the route files, services and tests listed in each section.
**Audited:** 2026-11-21.

> **Verification status. Please read this first.**
> The FrontDesk endpoints below are implemented and covered by automated tests (14 suites, all passing). Those tests use **simulated** clients against a test database.
> **No live connection to the real POS, StayBook or RoomCare systems has been tested yet.** None of these integrations should be considered operational until each team has completed a test against a running FrontDesk instance.

Related detailed references (kept in sync with this document): [POS_ORDERS.md](POS_ORDERS.md), [STAYBOOK.md](STAYBOOK.md), [ROOM_SYNC.md](ROOM_SYNC.md), [INTEGRATIONS.md](INTEGRATIONS.md).

---

## Contents

1. [Integration architecture](#1-integration-architecture)
2. [POS integration](#2-pos-integration)
3. [OnlineBooking integration](#3-onlinebooking-staybook-integration)
4. [RoomCare integration](#4-roomcare-integration)
5. [Authentication and security](#5-authentication-and-security)
6. [Request and response examples](#6-request-and-response-examples)
7. [Error handling and retry rules](#7-error-handling-and-retry-rules)
8. [Endpoints already implemented (FrontDesk)](#8-endpoints-already-implemented-frontdesk)
9. [Endpoints still required from the other systems](#9-endpoints-still-required-from-the-other-systems)
10. [Information and credentials still needed from each developer](#10-information-and-credentials-still-needed-from-each-developer)

---

## 1. Integration architecture

```
                      ┌──────────────────────────── FrontDesk ────────────────────────────┐
 Restaurant POS ──────► /api/v1/integrations/pos/*          (API key, optional signature)  │
                      │                                                                     │
 OnlineBooking ───────► /api/v1/integrations/staybook/*     (BOOKING key, optional sig.)   │
 (StayBook)           │                                                                     │
 RoomCare ────────────► /api/v1/integrations/housekeeping/* (HOUSEKEEPING key, signature   │
 (assumed = Housekeeping System, see §4.0)                    REQUIRED)                     │
                      │                                                                     │
                      │  domain events ──► transactional outbox ──► signed webhooks ───────┼──► POS_WEBHOOK_URL
                      │                                                                     ├──► BOOKING_WEBHOOK_URL (StayBook)
                      │                                                                     ├──► HOUSEKEEPING_WEBHOOK_URL (RoomCare)
                      │  room catalogue changes ──► room_sync_jobs ──► adapters ──── BLOCKED (contract pending)
                      └─────────────────────────────────────────────────────────────────────┘
```

**Inbound pipeline** (every request to `/api/v1/integrations/*`, in this order, from [integrations/index.js](../integrations/index.js)):

1. HTTPS check (`403 HTTPS_REQUIRED`; on by default in production).
2. Per-IP rate limit (4 × the per-system limit, so 480/min by default).
3. API key → which system is calling (`401 INVALID_API_KEY`).
4. Per-system rate limit (`INTEGRATION_RATE_LIMIT_PER_MINUTE`, default 120/min).
5. Signature check on writes (`401` on a bad signature; `503` for Housekeeping/RoomCare when the FrontDesk has no secret configured).
6. `Idempotency-Key` on writes (`400 IDEMPOTENCY_KEY_REQUIRED`).
7. Route: scope check (`403 INSUFFICIENT_SCOPE`) → validation (`422 VALIDATION_ERROR`) → business logic.

**Outbound** FrontDesk → external systems:

- **Webhooks (implemented).** Events are written to an outbox in the same database transaction as the business change. A worker POSTs them signed with HMAC-SHA256 and retries with backoff. Delivery is at least once, so receivers must de-duplicate on `event_id`.
- **Room catalogue sync (NOT sending).** The queue, worker, retry and monitoring exist. Both the StayBook and RoomCare adapters are **contract pending** ([integrations/roomSync/adapters.js](../integrations/roomSync/adapters.js)): they never send a request, and jobs wait as `BLOCKED` until each team publishes its room API (§9).

**Response envelope** (all FrontDesk endpoints, [utils/http.js](../utils/http.js)):

```json
{ "success": true,  "data": { … }, "meta": { … } }
{ "success": false, "error": { "code": "MACHINE_CODE", "message": "Human-readable text", "details": { … } } }
```

`meta` and `details` appear only when relevant. Unknown request fields are dropped by the validator and never stored. The request body limit is 100 KB.

**Base URL:** `https://<frontdesk-host>/api/v1/integrations`. For local development use `http://localhost:3000/api/v1/integrations`; HTTPS is not enforced unless `INTEGRATION_REQUIRE_HTTPS` is set or `NODE_ENV=production`.

---

## 2. POS integration

**Status: IMPLEMENTED and tested** ([integrations/pos/routes.js](../integrations/pos/routes.js), [integrations/pos/orderService.js](../integrations/pos/orderService.js); tests: `__tests__/integrations.pos-orders.test.js`, `__tests__/integrations.booking-pos.test.js`, `__tests__/integrations.security.test.js`). No proposed contract is needed.

### 2.1 Workflow

1. **Identify the guest (recommended).** Call `GET /pos/in-house?room_number=204` to get the `reservation_id` / `reservation_code` of the checked-in guest, or keep them from the `GuestCheckedIn` webhook.
2. **Send the completed order.** Call `POST /pos/orders` with items, quantities, unit prices, totals, `ordered_at`, `payment_status` and your `external_order_id`.
3. **FrontDesk stores it for review. It is never posted to the bill automatically.**
   - `PENDING_REVIEW`: every supplied reference agrees, the guest is in-house and the folio is open. A suggested stay is attached.
   - `NEEDS_GUEST_VERIFICATION`: something did not match. `verification_reasons` lists why, and a receptionist must choose the stay.
   - `ALREADY_PAID`: `payment_status: "PAID"`. Kept for information only; never billed to the room.
4. **Front-desk review** (staff screens, staff API `POST /api/v1/pos-orders/{id}/approve | reject`). Approval creates the folio charge (`ADDED_TO_FOLIO`); rejection sets `REJECTED`.
5. **FrontDesk notifies the POS** with the `PosOrderReviewed` webhook, if `POS_WEBHOOK_URL` is configured. You can also poll `GET /pos/orders/{restaurant_id}/{external_order_id}`.
6. **Void.** Re-send the **same** order with `order_status: "VOIDED"`. Before review, this rejects it. After it was added to the folio, the order is flagged for the front desk to correct the bill; the folio is never changed automatically.

### 2.2 Guest / room / stay association

The reliable identifier is the FrontDesk reservation: `reservation_id` or `reservation_code` (format `RSV-0007`). `guest_id`, `room_number` and `customer_name` are cross-checks only. The FrontDesk never matches by room number or name alone. Possible `verification_reasons`:
`NO_RESERVATION_REFERENCE`, `RESERVATION_NOT_FOUND`, `RESERVATION_REFERENCE_MISMATCH`, `GUEST_ID_MISMATCH`, `NOT_IN_HOUSE`, `ROOM_MISMATCH`, `NAME_MISMATCH`, `ORDERED_BEFORE_CHECK_IN`, `FOLIO_CLOSED`.

### 2.3 Duplicate prevention (two layers)

| Layer | Key | Behaviour |
|---|---|---|
| HTTP | `Idempotency-Key` header | Same key and same body → the stored answer is replayed with header `Idempotent-Replayed: true`. Same key with a different body → `422 IDEMPOTENCY_KEY_REUSED`. |
| Business | (`restaurant_id`, `external_order_id`), unique | Same order under a new key with identical content → `200` with `"duplicate": true`; nothing is created. Different content → `409 ORDER_CONFLICT` (void it and send a new order id). |

Recommended key format (from [POS_ORDERS.md](POS_ORDERS.md)): `pos-{restaurant_id}-{order_id}-{order_status}`.

### 2.4 `POST /pos/orders` fields (exact validator, [integrations/pos/routes.js](../integrations/pos/routes.js))

| Field | Required | Rule |
|---|---|---|
| `external_order_id` | yes | ≤ 64 chars, `[A-Za-z0-9._:-]` |
| `restaurant_id` | no | ≤ 40 chars, same pattern. Defaults to `POS_DEFAULT_RESTAURANT_ID` (default `MAIN`). Must be in `POS_RESTAURANT_IDS` when that list is set. |
| `outlet_name` | no | ≤ 80 |
| `customer_name` | no | ≤ 160 (cross-check) |
| `guest_id` | no | integer ≥ 1 (cross-check) |
| `reservation_id` | no* | integer ≥ 1 |
| `reservation_code` | no* | e.g. `RSV-0007` |
| `room_number` | no | ≤ 10 (cross-check) |
| `items[]` | yes | 1–100 items: `name` (required, ≤ 100), `quantity` (required, 1–1000), `unit_price` (required, ≥ 0), optional `sku` (≤ 50), `description` (≤ 255), `category` (`FOOD` / `BEVERAGE`) |
| `subtotal` | yes | must equal Σ `quantity × unit_price` |
| `service_charge`, `tax`, `discount` | no | ≥ 0, default 0 |
| `total` | yes | ≥ 0.01. Must equal `subtotal + service_charge + tax − discount` |
| `currency` | yes | ISO 4217. Must be the hotel currency (`PHP`) |
| `ordered_at` | yes | ISO-8601. Not more than 5 min in the future |
| `payment_status` | yes | `CHARGE_TO_ROOM`, `UNPAID`, `PAID` |
| `order_status` | yes | `COMPLETED`, `VOIDED`. A new order must be `COMPLETED`. |

\* Without either reservation reference the order is accepted but gets `NEEDS_GUEST_VERIFICATION` (`NO_RESERVATION_REFERENCE`).

### 2.5 Webhooks FrontDesk sends to the POS (implemented on the FrontDesk side)

Sent to `POS_WEBHOOK_URL`: `GuestCheckedIn`, `GuestCheckedOut`, `PosOrderReviewed` ([integrations/shared/subscriptions.js](../integrations/shared/subscriptions.js)). The POS must provide the receiver (§9).

### 2.6 Legacy endpoint

`POST /pos/room-charges` still works for existing clients but is **deprecated**. It posts straight to the folio without staff review and responds with `Deprecation: true` and `Link: </api/v1/integrations/pos/orders>; rel="successor-version"`. New work must use `POST /pos/orders`.

---

## 3. OnlineBooking (StayBook) integration

**Status: StayBook → FrontDesk is IMPLEMENTED and tested** ([integrations/staybook/routes.js](../integrations/staybook/routes.js), [integrations/staybook/staybookService.js](../integrations/staybook/staybookService.js); tests: `__tests__/integrations.staybook.test.js`, `__tests__/staybook.notifications.test.js`, `__tests__/integrations.roomsync.test.js`).
**FrontDesk → StayBook room sync is NOT IMPLEMENTED**: it is blocked until StayBook publishes a room API (§3.5, §9).

StayBook is treated as the Guest Booking System (Member 1). It authenticates with the **`BOOKING_API_KEY`**, which carries scopes `reservations:read` and `reservations:write`.

### 3.1 Room references and mapping

- StayBook identifies rooms by its own `staybook_room_id`. The FrontDesk resolves it through the `external_room_mappings` table (`source_system = STAYBOOK`). Responses return both ids: `staybook_room_id` and `frontdesk_room_id`. Numeric external ids are returned as numbers.
- **Today the mapping is created manually by the FrontDesk administrator** (Admin Console → Integrations; staff API `PUT /api/v1/admin/staybook/room-mappings/{staybookRoomId}` with body `{ "roomId": <frontdesk id>, "replace": false }`). These admin endpoints use a staff session and are **not** callable by StayBook.
- A booking for an unmapped room is refused with `422 ROOM_NOT_MAPPED`. If StayBook also sends `frontdesk_room_id`, it must agree with the mapping (`409 ROOM_MAPPING_MISMATCH`).
- Once StayBook provides a room API, room sync will store StayBook's returned room id in the same mapping table automatically.

### 3.2 How StayBook checks availability

| Endpoint | Use |
|---|---|
| `GET /staybook/rooms/available?check_in=YYYY-MM-DD&check_out=YYYY-MM-DD&guests=N[&hotel_id=]` | **Authoritative** bookable rooms for a stay. It accounts for walk-ins, in-house guests, maintenance and rooms out of service. Returns `rooms[]` (with `stay_total`) and `unavailable_rooms[]` with `reason`: `NOT_AVAILABLE`, `OUT_OF_SERVICE`, `CAPACITY_EXCEEDED`, `MAINTENANCE`. Only mapped rooms are listed. |
| `GET /staybook/rooms` | Current state of every mapped room: `room_status`, `occupancy_status` (`VACANT_CLEAN` / `VACANT_DIRTY` / `OCCUPIED` / `OUT_OF_ORDER`), `ready_for_guest`, `last_cleaned_at`, `in_service`. Use this to show whether a room is ready **right now**. Use `/rooms/available` for date-range booking decisions. |

StayBook should call `/rooms/available` before confirming a booking. `POST /reservations` re-checks availability anyway and refuses a taken room with `409 ROOM_UNAVAILABLE` / `NO_AVAILABILITY`.

### 3.3 Reservation create, update and cancel

| Operation | Endpoint | Notes |
|---|---|---|
| Create | `POST /staybook/reservations` | `booking_status` must be `LOCAL_CONFIRMED` or `ADMIN_CONFIRMED`; both become a `CONFIRMED` FrontDesk reservation. `payment_mode` only `SIMULATED`. |
| Read / acknowledgement | `GET /staybook/reservations/{id}` | `{id}` = FrontDesk reservation id (digits) or StayBook `booking_reference` |
| Update | `PATCH /staybook/reservations/{id}` | Partial. `updated_at` is **required** and orders revisions: older → `409 STALE_UPDATE`; equal → no-op; newer → applied. A different `staybook_room_id` moves the booking (availability is re-checked). |
| Cancel | `POST /staybook/reservations/{id}/cancel` | Body `{ "reason"?, "updated_at"? }`. Repeating it is harmless. Refused after check-in (`409 RESERVATION_NOT_MODIFIABLE`). |

**Create fields** (exact validator): `source_system` (`"STAYBOOK"`), `source_booking_id`, `booking_reference`, `guest { first_name, last_name, email?, phone? }`, `hotel_id`, `staybook_room_id`, `frontdesk_room_id?`, `check_in`, `check_out`, `guests` (1–20), `nights` (1–60, must equal the dates), `nightly_rate`, `total_amount`, `currency` (hotel currency), `booking_status`, `payment_mode?`, `updated_at` (ISO-8601).
**Duplicates:** `source_booking_id` and `booking_reference` are unique. A second create returns `409 DUPLICATE_RESERVATION` with the existing reservation in `error.details`. **Treat that as synced.**
**Hotel guard:** when `STAYBOOK_HOTEL_ID` is set on the FrontDesk, any other `hotel_id` gets `422 HOTEL_NOT_MANAGED`.

Each create, update and cancel also creates a front-desk staff notification. Refused writes are reported to staff too; the answer StayBook receives is unchanged.

### 3.4 Webhooks FrontDesk sends to StayBook (implemented on the FrontDesk side)

These go to `BOOKING_WEBHOOK_URL`, only for bookings that came from StayBook and never as an echo of StayBook's own change: `ReservationUpdated`, `ReservationCancelled`, `GuestCheckedIn`, `GuestCheckedOut`. StayBook must provide the receiver (§9).

### 3.5 FrontDesk → OnlineBooking room sync: NOT IMPLEMENTED (contract pending)

What exists on the FrontDesk side ([integrations/roomSync/](../integrations/roomSync/)):

- When an admin creates, edits, archives or restores a room, a job is queued for StayBook. This only happens if `STAYBOOK_API_URL` is set.
- The worker will call `create` (no mapping yet), `update(staybook_room_id)` or `deactivate(staybook_room_id)`. A hard delete is never sent.
- Create uses a stable idempotency key: `frontdesk:room:{frontdesk_room_id}:staybook:create`.
- The StayBook id returned by create is stored in `external_room_mappings`.

What does **not** exist: the HTTP calls. The StayBook adapter is a stub that throws `ContractPendingError`, so **no request is ever sent** and jobs stay `BLOCKED`. StayBook's current API has no room endpoints and no server-to-server authentication. **OnlineBooking must implement these endpoints** (§9.2).

The FrontDesk room record that the adapter will map onto StayBook's contract (`roomSnapshot()` in [roomSyncService.js](../integrations/roomSync/roomSyncService.js); internal fields, **not** a wire format):
`frontdesk_room_id`, `room_number`, `room_type`, `room_type_id`, `floor`, `capacity`, `nightly_rate`, `currency`, `description`, `amenities[]`, `status`, `occupancy_status`, `is_active`, `archived`, `updated_at`.

---

## 4. RoomCare integration

### 4.0 Unverified assumption: RoomCare = Housekeeping System (Member 3)

The FrontDesk currently treats **RoomCare as the Housekeeping System**. It uses the same endpoints (`/api/v1/integrations/housekeeping/*`) and the same credentials (`HOUSEKEEPING_API_KEY`, `HOUSEKEEPING_INBOUND_SECRET`, `HOUSEKEEPING_WEBHOOK_URL`, `HOUSEKEEPING_WEBHOOK_SECRET`). **Member 3 has not confirmed this.** If RoomCare is a separate system, a separate client and credentials must be added before go-live.

**Status:**

| Direction | Status |
|---|---|
| RoomCare → FrontDesk cleaning callbacks | **IMPLEMENTED and tested** (`__tests__/integrations.roomsync.test.js`, `__tests__/rooms.cleaning-guard.test.js`, `__tests__/integrations.workflow.test.js`, `__tests__/integrations.security.test.js`) |
| FrontDesk → RoomCare `RoomVacated` cleaning notification | **IMPLEMENTED on the FrontDesk side** (webhook). RoomCare's receiver does not exist yet. |
| FrontDesk → RoomCare room create / update / deactivate | **NOT IMPLEMENTED (contract pending)**. Adapter stub, nothing is sent. |

### 4.1 FrontDesk → RoomCare: `RoomVacated` cleaning notification (webhook)

When a guest checks out (`reason: "CHECKOUT"`) or is moved out of a room (`reason: "ROOM_MOVE"`), the room becomes `DIRTY`. In the same transaction, a `RoomVacated` event is queued for `HOUSEKEEPING_WEBHOOK_URL`.

- **Method / target:** `POST <HOUSEKEEPING_WEBHOOK_URL>`, `Content-Type: application/json`. HTTPS is required in production, and the receiver must answer 2xx within 10 s.
- **Headers:** `X-PMS-Event: RoomVacated`, `X-PMS-Event-Id`, `X-PMS-Delivery`, `X-PMS-Timestamp`, and `X-PMS-Signature` (only when `HOUSEKEEPING_WEBHOOK_SECRET` is set). See §5.4.
- **Body:** see §6.3. It includes `room_id` and `room_number` (FrontDesk ids), `roomcare_room_id` (RoomCare's id, or `null` until room sync maps it), `room_status: "DIRTY"`, `cleaning_status: "PENDING"` and a human-readable `message`.
- The same Housekeeping target also receives `RoomStatusChanged` and `RoomCleaned`, each with `roomcare_room_id`.
- The receiver's response body (first 1000 characters, for example a RoomCare task id) is stored and shown in Admin Console → Integrations → Cleaning notifications.

### 4.2 RoomCare → FrontDesk: cleaning-status callback

**Endpoint:** `POST /api/v1/integrations/housekeeping/cleaning-status` (scope `housekeeping:write`).
The older single-purpose endpoints `/cleaning-tasks`, `/cleaning-started` and `/cleaning-completed` apply exactly the same rules and remain available.

| Field | Required | Rule |
|---|---|---|
| `status` | always | `PENDING`, `IN_PROGRESS`, `COMPLETED` (case-insensitive) |
| `external_task_id` | always | RoomCare task id, ≤ 100, `[A-Za-z0-9._:-]`. Globally unique; one task belongs to one room. |
| `room_id` **or** `room_number` | one of them | **FrontDesk** room id (integer) or room number (≤ 10). If both are sent they must match (`409 ROOM_MISMATCH`). `roomcare_room_id` is **not** accepted as an identifier. |
| `event_id` | no | The `RoomVacated` `event_id` this task answers (≤ 30). Defaults to the room's latest `RoomVacated`. |
| `assigned_to` | no | for `PENDING`; employee id ≤ 60 |
| `started_by` | for `IN_PROGRESS` | employee id ≤ 60 |
| `started_at` | no | ISO-8601. Defaults to now. Not in the future. |
| `completed_by`, `completed_at` | both, for `COMPLETED` | `completed_at` must not be in the future (5-minute clock skew allowed) and not before `started_at` |
| `remarks` | no | ≤ 500 |

**Effect on the FrontDesk room** ([housekeepingService.js](../integrations/housekeeping/housekeepingService.js), [roomStatusService.js](../services/roomStatusService.js)):

| `status` | HTTP | Room effect |
|---|---|---|
| `PENDING` | 201 | Task recorded. The room stays `DIRTY` (`VACANT_DIRTY`). |
| `IN_PROGRESS` | 200 | `DIRTY → CLEANING` |
| `COMPLETED` | 200 | `CLEANING` (or `DIRTY`) → `AVAILABLE`, or `RESERVED` when a confirmed reservation is assigned to the room. `completed_at` becomes the room's `last_cleaned_at`, `cleaning_required` is cleared and `RoomCleaned` is published. |

**Rooms under maintenance.** A room that went into `MAINTENANCE` before it was cleaned keeps `cleaning_required = 1`. RoomCare tasks for it are accepted. The room **stays** `MAINTENANCE`; a verified completion only clears the cleaning requirement, so an administrator can then end maintenance. Until a verified cleaning, the FrontDesk refuses to make the room ready (`409 ROOM_NEEDS_CLEANING` on the staff side).

### 4.3 Signing requirement and behaviour when the secret is missing or invalid

Housekeeping/RoomCare **must** sign every write (`inboundSigningRequired: true` in [integrations/shared/clients.js](../integrations/shared/clients.js)).

| Situation | Result |
|---|---|
| `HOUSEKEEPING_INBOUND_SECRET` **not configured** on the FrontDesk (any `NODE_ENV` except `test`) | Every write: **`503 INBOUND_SIGNING_NOT_CONFIGURED`**. The request is refused before the idempotency store; unsigned writes are never accepted. When `HOUSEKEEPING_API_KEY` is set, the missing secret is also logged as an error at startup. |
| Secret configured, `X-Timestamp` or `X-Signature` missing | `401 SIGNATURE_REQUIRED` |
| Timestamp more than ±300 s from FrontDesk time | `401 SIGNATURE_EXPIRED` |
| Signature wrong / malformed timestamp | `401 INVALID_SIGNATURE` |
| Reads (`GET /housekeeping/rooms…`) | No signature needed |

### 4.4 Other RoomCare-facing endpoints (implemented)

- `GET /housekeeping/rooms[?status=]`: active rooms with `status`, `last_cleaned_at` and the open task.
- `GET /housekeeping/rooms/{roomNumber}`: one room.

### 4.5 FrontDesk → RoomCare room sync: NOT IMPLEMENTED (contract pending)

The mechanism is the same as for StayBook (§3.5): the target is enabled by `ROOMCARE_API_URL` / `ROOMCARE_API_TOKEN`, and the create key is `frontdesk:room:{id}:roomcare:create`. The returned id is stored as `external_room_mappings(source_system = ROOMCARE)` and then sent back to RoomCare as `roomcare_room_id` in webhooks. **No request is sent** until RoomCare publishes a room API (§9.3).

---

## 5. Authentication and security

### 5.1 Credentials per system (environment variables on the FrontDesk)

| System | API key (inbound) | Scopes | Inbound signing secret | Webhook URL / secret (outbound) |
|---|---|---|---|---|
| POS | `POS_API_KEY` | `folio:read`, `room_charges:write`, `pos_orders:write`, `pos_orders:read` | `POS_INBOUND_SECRET`: **optional**; when set, every POS write must be signed | `POS_WEBHOOK_URL`, `POS_WEBHOOK_SECRET` |
| OnlineBooking (StayBook) | `BOOKING_API_KEY` | `reservations:read`, `reservations:write` | `BOOKING_INBOUND_SECRET`: **optional** | `BOOKING_WEBHOOK_URL`, `BOOKING_WEBHOOK_SECRET` |
| RoomCare (as Housekeeping) | `HOUSEKEEPING_API_KEY` | `rooms:read`, `housekeeping:write` | `HOUSEKEEPING_INBOUND_SECRET`: **REQUIRED** | `HOUSEKEEPING_WEBHOOK_URL`, `HOUSEKEEPING_WEBHOOK_SECRET` |
| FrontDesk → StayBook room API | n/a | n/a | n/a | `STAYBOOK_API_URL`, `STAYBOOK_API_TOKEN` (issued **by StayBook**; header format to be defined by StayBook) |
| FrontDesk → RoomCare room API | n/a | n/a | n/a | `ROOMCARE_API_URL`, `ROOMCARE_API_TOKEN` (issued **by RoomCare**) |

An empty API key disables that system. A valid key used on another system's endpoint gets `403 INSUFFICIENT_SCOPE`. Keys are compared as SHA-256 digests in constant time.

### 5.2 Required headers on inbound calls

| Header | When | Value |
|---|---|---|
| `X-Api-Key: <key>` **or** `Authorization: Bearer <key>` | always | system API key |
| `Content-Type: application/json` | requests with a body | |
| `Idempotency-Key` | every POST / PATCH / PUT / DELETE | 8–100 chars `[A-Za-z0-9._:-]`, one per logical operation, reused on retries |
| `X-Timestamp` | writes, when the system has an inbound secret (always for RoomCare) | Unix seconds |
| `X-Signature` | same | `sha256=` + hex(HMAC-SHA256(secret, `` `${X-Timestamp}.${rawBody}` ``)) |

The signature covers the **exact raw body bytes** sent, so sign the same string you transmit. Example (Node.js):

```js
const raw = JSON.stringify(body);
const ts = Math.floor(Date.now() / 1000).toString();
const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
// headers: { "X-Timestamp": ts, "X-Signature": sig, "Content-Type": "application/json", ... }; body: raw
```

### 5.3 Transport

- Production refuses plain HTTP on integration endpoints (`403 HTTPS_REQUIRED`). Behind a TLS proxy the FrontDesk must run with `TRUST_PROXY=true`.
- In production, outbound webhooks are sent only to `https://` URLs; otherwise the delivery is marked FAILED.

### 5.4 Verifying FrontDesk webhooks (receivers: POS, StayBook, RoomCare)

Headers: `X-PMS-Event`, `X-PMS-Event-Id` (= body `event_id`, e.g. `EVT-000042`), `X-PMS-Delivery` (delivery row id, differs per receiver), `X-PMS-Timestamp`, and `X-PMS-Signature: sha256=<hex HMAC-SHA256(<SYSTEM>_WEBHOOK_SECRET, "${X-PMS-Timestamp}.${rawBody}")>`. The signature header is present only when the webhook secret is configured, and it should always be configured in production.

Receivers must: verify the signature against the raw body, reject timestamps older than about 300 s, de-duplicate on `event_id`, and answer 2xx within 10 s. A full receiver example is in [INTEGRATIONS.md §6](INTEGRATIONS.md#6-webhooks-pms--your-system).

### 5.5 Privacy

Responses and webhooks carry references, statuses and masked guest names (`J. Doe`) only. They never contain guest contact details. StayBook must never send card data; `payment_mode` stays `SIMULATED`.

---

## 6. Request and response examples

All examples follow the validators and serializers in the code. Ids, timestamps and amounts are illustrative.

### 6.1 POS

**Notify an order**

```http
POST /api/v1/integrations/pos/orders
X-Api-Key: <POS_API_KEY>
Idempotency-Key: pos-R1-ORD-10001-COMPLETED
Content-Type: application/json

{
  "external_order_id": "ORD-10001",
  "restaurant_id": "R1",
  "outlet_name": "Lobby Restaurant",
  "customer_name": "John Doe",
  "reservation_code": "RSV-0007",
  "room_number": "204",
  "items": [
    { "sku": "F-12", "name": "Club sandwich", "category": "FOOD", "quantity": 2, "unit_price": 350.00 },
    { "sku": "B-03", "name": "Iced tea", "category": "BEVERAGE", "quantity": 1, "unit_price": 100.00 }
  ],
  "subtotal": 800.00,
  "service_charge": 80.00,
  "tax": 0,
  "discount": 0,
  "total": 880.00,
  "currency": "PHP",
  "ordered_at": "2026-12-02T13:00:00+08:00",
  "payment_status": "CHARGE_TO_ROOM",
  "order_status": "COMPLETED"
}
```

`202 Accepted` (new order), or `200` for a re-delivery under a new key, where `"duplicate": true`:

```json
{ "success": true, "data": {
  "order_ref": "PO-000031", "restaurant_id": "R1", "external_order_id": "ORD-10001",
  "status": "PENDING_REVIEW", "verification_reasons": [],
  "reservation_id": 7, "reservation_code": "RSV-0007", "room_number": "204", "guest_display_name": "J. Doe",
  "total": 880, "currency": "PHP", "payment_status": "CHARGE_TO_ROOM", "order_status": "COMPLETED",
  "charge_id": null, "received_at": "2026-12-02T05:00:01.000Z", "reviewed_at": null,
  "rejection_reason": null, "voided_at": null, "duplicate": false } }
```

With an uncertain match the status is `NEEDS_GUEST_VERIFICATION`, `verification_reasons` is filled (e.g. `["ROOM_MISMATCH"]`), and `reservation_id`, `reservation_code`, `room_number` and `guest_display_name` are `null`.

**Review status:** `GET /api/v1/integrations/pos/orders/R1/ORD-10001` → `200` with the same `data` shape, or `404 NOT_FOUND`.

**In-house lookup:** `GET /api/v1/integrations/pos/in-house?room_number=204` returns:

```json
{ "success": true, "data": {
  "reservation_id": 7, "reservation_code": "RSV-0007", "stay_id": 5, "room_number": "204",
  "guest_display_name": "J. Doe", "checked_in_at": "2026-12-01T06:12:00.000Z",
  "expected_check_out_date": "2026-12-04", "folio_open": true } }
```

If the room has no checked-in guest: `404 NO_IN_HOUSE_GUEST`.

**Webhook `PosOrderReviewed`** (to `POS_WEBHOOK_URL`); `status` is `ADDED_TO_FOLIO` or `REJECTED`:

```json
{ "event": "PosOrderReviewed", "event_id": "EVT-000123", "occurred_at": "2026-12-02T05:03:12.000Z",
  "pos_order_id": 31, "order_ref": "PO-000031", "restaurant_id": "R1", "external_order_id": "ORD-10001",
  "status": "ADDED_TO_FOLIO", "reservation_id": 7, "reservation_code": "RSV-0007", "stay_id": 5, "room_number": "204",
  "charge_id": 88, "amount": 880, "currency": "PHP", "reviewed_at": "2026-12-02T05:03:12.000Z", "rejection_reason": null }
```

### 6.2 OnlineBooking (StayBook)

**Availability:** `GET /api/v1/integrations/staybook/rooms/available?check_in=2026-12-10&check_out=2026-12-12&guests=2`

```json
{ "success": true, "data": {
  "hotel_id": 1, "check_in": "2026-12-10", "check_out": "2026-12-12", "nights": 2, "guests": 2, "currency": "PHP",
  "rooms": [ { "staybook_room_id": 1, "frontdesk_room_id": 3, "room_number": "204", "room_type": "Deluxe",
               "capacity": 2, "nightly_rate": 3500, "stay_total": 7000 } ],
  "unavailable_rooms": [ { "staybook_room_id": 2, "frontdesk_room_id": 4, "room_number": "301", "room_type": "Suite",
                           "capacity": 4, "nightly_rate": 6000, "reason": "MAINTENANCE" } ] } }
```

**Current room state:** `GET /api/v1/integrations/staybook/rooms`

```json
{ "success": true, "data": {
  "hotel_id": 1, "currency": "PHP", "generated_at": "2026-12-03T11:05:00.000Z",
  "rooms": [ { "staybook_room_id": 1, "frontdesk_room_id": 3, "room_number": "204", "room_type": "Deluxe",
               "capacity": 2, "nightly_rate": 3500, "description": null, "amenities": [],
               "in_service": true, "room_status": "DIRTY", "occupancy_status": "VACANT_DIRTY",
               "ready_for_guest": false, "last_cleaned_at": "2026-12-01T03:00:00.000Z",
               "status_changed_at": "2026-12-03T11:00:00.000Z" } ] } }
```

**Create**

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

`201 Created`. The same shape is returned by `GET`, `PATCH` and `/cancel`:

```json
{ "success": true, "data": {
  "frontdesk_reservation_id": 12, "reservation_code": "RSV-0012",
  "source_system": "STAYBOOK", "source_booking_id": 123, "booking_reference": "SB-EXAMPLE12345", "hotel_id": 1,
  "staybook_room_id": 1, "frontdesk_room_id": 3, "room_number": "204", "room_type": "Deluxe",
  "room_assignment": "AS_BOOKED", "assigned_staybook_room_id": 1,
  "check_in": "2026-12-10", "check_out": "2026-12-12", "guests": 2, "nights": 2,
  "nightly_rate": 3500, "total_amount": 7000, "currency": "PHP",
  "frontdesk_nightly_rate": 3500, "rate_matches_frontdesk": true,
  "booking_status": "LOCAL_CONFIRMED", "frontdesk_status": "CONFIRMED",
  "payment_mode": "SIMULATED", "payment_recorded": false, "sync_status": "ACKNOWLEDGED",
  "source_updated_at": "2026-12-01T08:00:00.123Z",
  "acknowledged_at": "2026-12-01T08:00:01.000Z", "last_synced_at": "2026-12-01T08:00:01.000Z" } }
```

`room_assignment` is `AS_BOOKED`, `CHANGED_BY_FRONT_DESK` or `PENDING`. `sync_status` is `ACKNOWLEDGED`, `UPDATED` or `CANCELLED`.

**Update:** `PATCH /api/v1/integrations/staybook/reservations/SB-EXAMPLE12345`

```json
{ "check_out": "2026-12-13", "nights": 3, "total_amount": 10500.00, "updated_at": "2026-12-02T09:00:00.000Z" }
```

**Cancel:** `POST /api/v1/integrations/staybook/reservations/SB-EXAMPLE12345/cancel`

```json
{ "reason": "Guest cancelled online", "updated_at": "2026-12-05T10:00:00.000Z" }
```

### 6.3 RoomCare

**Webhook `RoomVacated`** (FrontDesk → `HOUSEKEEPING_WEBHOOK_URL`)

```http
POST <HOUSEKEEPING_WEBHOOK_URL>
Content-Type: application/json
X-PMS-Event: RoomVacated
X-PMS-Event-Id: EVT-000010
X-PMS-Delivery: 8
X-PMS-Timestamp: 1796295600
X-PMS-Signature: sha256=<hex>

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
  "reason": "CHECKOUT",
  "room_status": "DIRTY",
  "cleaning_status": "PENDING",
  "message": "Room 204 needs cleaning. A guest has checked out. Please prepare the room for the next guest.",
  "roomcare_room_id": null
}
```

**Callback: task created** (RoomCare → FrontDesk)

```http
POST /api/v1/integrations/housekeeping/cleaning-status
X-Api-Key: <HOUSEKEEPING_API_KEY>
Idempotency-Key: roomcare-RC-TASK-501-PENDING
X-Timestamp: 1796295660
X-Signature: sha256=<hex HMAC-SHA256(HOUSEKEEPING_INBOUND_SECRET, "1796295660.<raw body>")>
Content-Type: application/json

{ "status": "PENDING", "external_task_id": "RC-TASK-501", "room_id": 3, "event_id": "EVT-000010", "assigned_to": "EMP-014" }
```

`201 Created`:

```json
{ "success": true, "data": {
  "external_task_id": "RC-TASK-501", "task_status": "OPEN", "room_id": 3, "room_number": "204", "room_status": "DIRTY",
  "stay_id": 1, "source_event_id": "EVT-000010", "started_at": null, "started_by": null,
  "completed_at": null, "completed_by": null, "remarks": null, "recorded_at": "2026-12-03T11:01:00.000Z",
  "cleaning_status": "PENDING" } }
```

**Callback: started:** `{ "status": "IN_PROGRESS", "external_task_id": "RC-TASK-501", "room_id": 3, "started_by": "EMP-014", "started_at": "2026-12-03T11:10:00Z" }` → `200`, `room_status: "CLEANING"`, `task_status: "IN_PROGRESS"`.

**Callback: completed**

```json
{ "status": "COMPLETED", "external_task_id": "RC-TASK-501", "room_id": 3,
  "completed_by": "EMP-014", "completed_at": "2026-12-03T11:40:00Z", "remarks": "Linen replaced" }
```

`200 OK`:

```json
{ "success": true, "data": {
  "external_task_id": "RC-TASK-501", "task_status": "COMPLETED", "room_id": 3, "room_number": "204",
  "room_status": "AVAILABLE", "stay_id": 1, "source_event_id": "EVT-000010",
  "started_at": "2026-12-03T11:10:00.000Z", "started_by": "EMP-014",
  "completed_at": "2026-12-03T11:40:00.000Z", "completed_by": "EMP-014", "remarks": "Linen replaced",
  "recorded_at": "2026-12-03T11:40:01.000Z", "previous_room_status": "CLEANING", "cleaning_status": "COMPLETED" } }
```

`room_status` is `RESERVED` instead of `AVAILABLE` when a confirmed reservation is assigned to the room, and `MAINTENANCE` when the cleaning was recorded during maintenance.

**Missing secret on the FrontDesk:**

```json
HTTP/1.1 503 Service Unavailable
{ "success": false, "error": { "code": "INBOUND_SIGNING_NOT_CONFIGURED",
  "message": "Signed requests are required for this system, but the PMS has no signing secret configured for it. Writes are refused until the PMS administrator configures it." } }
```

---

## 7. Error handling and retry rules

### 7.1 Common errors (all systems)

| HTTP | `code` | Meaning | Retry? |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Header missing or malformed on a write | No: fix the client |
| 400 | `INVALID_JSON` | Body is not valid JSON | No |
| 401 | `INVALID_API_KEY` | Missing or wrong key | No: fix the configuration |
| 401 | `SIGNATURE_REQUIRED` / `INVALID_SIGNATURE` / `SIGNATURE_EXPIRED` | Signing problem or clock off by more than 300 s | Re-sign with a fresh timestamp after fixing the secret or clock |
| 403 | `INSUFFICIENT_SCOPE` | Another system's key | No |
| 403 | `HTTPS_REQUIRED` | Plain HTTP in production | No: use HTTPS |
| 404 | `NOT_FOUND` | No such integration endpoint | No |
| 409 | `REQUEST_IN_PROGRESS` | Same `Idempotency-Key` still processing | **Yes**, shortly, same key |
| 422 | `VALIDATION_ERROR` | `error.details` = per-field messages | No: fix the data |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key with a different body | No: new key for a new operation |
| 429 | `RATE_LIMITED` | Over the limit; honour `Retry-After` | **Yes** |
| 503 | `INBOUND_SIGNING_NOT_CONFIGURED` | RoomCare/Housekeeping only: FrontDesk secret missing | After the FrontDesk admin sets the secret |
| 5xx / timeout / network | n/a | Not stored by the FrontDesk | **Yes, with the same `Idempotency-Key`** |

### 7.2 System-specific business errors

| System | HTTP | `code` | Action |
|---|---|---|---|
| POS | 409 | `ORDER_CONFLICT` | Same order id with different content. Void it and send a new order id. |
| POS | 404 | `NO_IN_HOUSE_GUEST` (in-house lookup), `NOT_FOUND` (order status) | No retry |
| StayBook | 409 | `DUPLICATE_RESERVATION` | **Treat as synced**; `error.details` is the existing reservation |
| StayBook | 409 | `ROOM_UNAVAILABLE`, `NO_AVAILABILITY` | Room taken; nothing stored. Needs staff action. |
| StayBook | 409 | `ROOM_MAPPING_MISMATCH`, `ROOM_OUT_OF_SERVICE` | Inventory/mapping problem at the FrontDesk |
| StayBook | 409 | `RESERVATION_NOT_MODIFIABLE`, `STALE_UPDATE` | No retry |
| StayBook | 422 | `ROOM_NOT_MAPPED`, `HOTEL_NOT_MANAGED` | Ask the FrontDesk admin to map the room or check `hotel_id`; retry after the fix with a new key |
| StayBook | 404 | `RESERVATION_NOT_FOUND` | Not synced yet, or not a StayBook booking |
| RoomCare | 404 | `ROOM_NOT_FOUND` | Wrong `room_id` / `room_number` |
| RoomCare | 409 | `ROOM_MISMATCH`, `EVENT_ROOM_MISMATCH`, `TASK_ROOM_MISMATCH` | Identifiers disagree; fix the data |
| RoomCare | 409 | `DUPLICATE_TASK` | Task id already registered |
| RoomCare | 409 | `TASK_ALREADY_STARTED` | Task already in progress or done |
| RoomCare | 409 | `ROOM_NOT_AWAITING_CLEANING` | Room is not `DIRTY` / `CLEANING` (or `MAINTENANCE` with cleaning pending) |
| RoomCare | 409 | `TASK_SUPERSEDED` | The front desk already marked the room clean |
| RoomCare | 409 | `DUPLICATE_CLEANING_COMPLETION` | Completion already applied. Treat as done. |

### 7.3 Retry rules for callers (POS, StayBook, RoomCare → FrontDesk)

1. Generate **one `Idempotency-Key` per logical operation** and reuse it on every retry of that operation.
2. Retry only on network errors, timeouts, `429`, `5xx` and `409 REQUEST_IN_PROGRESS`, with exponential backoff.
3. Never retry other `4xx` errors unchanged. Fix the cause first; if the body changes, use a new key.
4. Keep the business id stable (`external_order_id`, `booking_reference`, `external_task_id`). The FrontDesk's unique constraints prevent duplicates even when keys differ.

### 7.4 FrontDesk retry behaviour (outbound)

- **Webhooks:** backoff of 30 s, 1 min, 2 min, … up to 1 h, for at most `INTEGRATION_OUTBOX_MAX_ATTEMPTS` attempts (default 8), each with a 10 s timeout. After that the delivery is `FAILED` and an admin can re-send it from Admin Console → Integrations. A failed StayBook webhook also creates a staff notification.
- **Room sync (once enabled):** same backoff, `ROOM_SYNC_MAX_ATTEMPTS` (default 8), `ROOM_SYNC_TIMEOUT_MS` (default 10 s). Retryable failures go back to `PENDING`; 4xx or exhausted attempts become `FAILED`. Targets fail independently.

---

## 8. Endpoints already implemented (FrontDesk)

All paths are relative to `/api/v1/integrations`. "Tested" means covered by the automated Jest suites against a test database with simulated clients, **not** a live test with the real external system.

| System | Method | Path | Purpose | Auth / scope | Required headers | Implemented & tested |
|---|---|---|---|---|---|---|
| POS | POST | `/pos/orders` | Notify a completed or voided order for front-desk review | POS key, `pos_orders:write` | key, `Idempotency-Key`, `Content-Type`; signature if `POS_INBOUND_SECRET` set | Yes / `integrations.pos-orders.test.js` |
| POS | GET | `/pos/orders/{restaurant_id}/{external_order_id}` | Review status of an order | POS key, `pos_orders:read` | key | Yes / `integrations.pos-orders.test.js` |
| POS | GET | `/pos/in-house?room_number=` | Checked-in guest (masked) + reservation for a room | POS key, `folio:read` | key | Yes / `integrations.booking-pos.test.js`, `integrations.security.test.js` |
| POS | POST | `/pos/room-charges` | **Deprecated** direct folio posting | POS key, `room_charges:write` | as `/pos/orders` | Yes / `integrations.booking-pos.test.js` |
| POS | GET | `/pos/room-charges/{external_transaction_id}` | Legacy charge lookup | POS key, `folio:read` | key | Yes / `integrations.booking-pos.test.js` |
| StayBook | GET | `/staybook/rooms` | Current state of every mapped room | BOOKING key, `reservations:read` | key | Yes / `integrations.roomsync.test.js` |
| StayBook | GET | `/staybook/rooms/available?check_in&check_out&guests[&hotel_id]` | Authoritative availability of mapped rooms | BOOKING key, `reservations:read` | key | Yes / `integrations.staybook.test.js` |
| StayBook | POST | `/staybook/reservations` | New online booking | BOOKING key, `reservations:write` | key, `Idempotency-Key`, `Content-Type`; signature if `BOOKING_INBOUND_SECRET` set | Yes / `integrations.staybook.test.js`, `staybook.notifications.test.js` |
| StayBook | GET | `/staybook/reservations/{id}` | Acknowledgement / current state | BOOKING key, `reservations:read` | key | Yes / `integrations.staybook.test.js` |
| StayBook | PATCH | `/staybook/reservations/{id}` | Later revision | BOOKING key, `reservations:write` | as POST | Yes / `integrations.staybook.test.js`, `staybook.notifications.test.js` |
| StayBook | POST | `/staybook/reservations/{id}/cancel` | Cancellation | BOOKING key, `reservations:write` | as POST | Yes / `integrations.staybook.test.js`, `staybook.notifications.test.js` |
| RoomCare* | POST | `/housekeeping/cleaning-status` | Cleaning task status `PENDING` / `IN_PROGRESS` / `COMPLETED` | HOUSEKEEPING key, `housekeeping:write` | key, `Idempotency-Key`, `Content-Type`, **`X-Timestamp`, `X-Signature` (required)** | Yes / `integrations.roomsync.test.js`, `rooms.cleaning-guard.test.js`, `integrations.security.test.js` |
| RoomCare* | POST | `/housekeeping/cleaning-tasks` | Register task (= `PENDING`) | same | same | Yes / `integrations.workflow.test.js`, `integrations.security.test.js` |
| RoomCare* | POST | `/housekeeping/cleaning-started` | Start (= `IN_PROGRESS`) | same | same | Yes / `integrations.workflow.test.js` |
| RoomCare* | POST | `/housekeeping/cleaning-completed` | Complete (body `status: "COMPLETED"`) | same | same | Yes / `integrations.workflow.test.js`, `integrations.security.test.js` |
| RoomCare* | GET | `/housekeeping/rooms[?status=]` | Room board | HOUSEKEEPING key, `rooms:read` | key | Yes / `integrations.security.test.js` |
| RoomCare* | GET | `/housekeeping/rooms/{roomNumber}` | One room | HOUSEKEEPING key, `rooms:read` | key | Yes / `integrations.workflow.test.js` |

\* Under the unverified assumption that RoomCare is the Housekeeping System (§4.0).

**Outbound webhooks implemented on the FrontDesk side** (each receiver still has to be built by the other team, see §9):

| Receiver | Events | Config |
|---|---|---|
| POS | `GuestCheckedIn`, `GuestCheckedOut`, `PosOrderReviewed` | `POS_WEBHOOK_URL`, `POS_WEBHOOK_SECRET` |
| StayBook | `ReservationUpdated`, `ReservationCancelled`, `GuestCheckedIn`, `GuestCheckedOut` (its own bookings, front-desk changes only) | `BOOKING_WEBHOOK_URL`, `BOOKING_WEBHOOK_SECRET` |
| RoomCare | `RoomVacated`, `RoomStatusChanged`, `RoomCleaned` (each with `roomcare_room_id`) | `HOUSEKEEPING_WEBHOOK_URL`, `HOUSEKEEPING_WEBHOOK_SECRET` |

The legacy Guest Booking System contract (`/booking/room-types`, `/booking/availability`, `/booking/reservations…`, same BOOKING key) is also implemented and tested (`integrations.booking-pos.test.js`). StayBook should use the `/staybook/*` contract above.

---

## 9. Endpoints still required from the other systems

None of these exist yet as far as the FrontDesk knows, so the FrontDesk cannot call them.

### 9.1 Restaurant POS must provide

| # | What | Required? | Contract |
|---|---|---|---|
| P1 | Webhook receiver (HTTPS POST) for `GuestCheckedIn`, `GuestCheckedOut`, `PosOrderReviewed` | Recommended: needed to learn about review decisions without polling | Defined by the FrontDesk (§5.4, §6.1) |
| P2 | Client calls to `POST /pos/orders` (and the void re-send), with idempotency and retries | **Required** | Defined by the FrontDesk (§2) |

### 9.2 OnlineBooking (StayBook) must provide

| # | What | Required? | Contract |
|---|---|---|---|
| B1 | Server-side client calling `POST/PATCH/cancel /staybook/reservations` after each booking change, with deterministic keys and a retry queue (reference client: [docs/staybook/frontdeskClient.js](staybook/frontdeskClient.js)) | **Required** | Defined by the FrontDesk (§3) |
| B2 | Call `GET /staybook/rooms/available` before confirming a booking | **Required** | Defined by the FrontDesk |
| B3 | Webhook receiver (HTTPS POST) for `ReservationUpdated`, `ReservationCancelled`, `GuestCheckedIn`, `GuestCheckedOut` | **Required** for two-way sync | Defined by the FrontDesk |
| B4 | **Server-to-server authentication** for StayBook's own API (API key / bearer token). Today StayBook only has session cookie + CSRF. | Required for room sync | **To be defined by StayBook** |
| B5 | **Create room** endpoint, returning StayBook's room id | Required for room sync | **To be defined by StayBook** |
| B6 | **Update room** endpoint addressed by StayBook room id (number, type, capacity, rate, description, amenities, active) | Required for room sync | **To be defined by StayBook** |
| B7 | **Deactivate / unpublish room** endpoint, or confirmation that an update with an inactive flag is the way. No hard delete. | Required for room sync | **To be defined by StayBook** |
| B8 | Duplicate protection on create: `Idempotency-Key` support, or lookup by FrontDesk room id | Required for room sync | **To be defined by StayBook** |

### 9.3 RoomCare must provide

| # | What | Required? | Contract |
|---|---|---|---|
| R1 | Webhook receiver (HTTPS POST) for `RoomVacated` (also `RoomStatusChanged`, `RoomCleaned`) that creates the cleaning task | **Required** | Defined by the FrontDesk (§4.1, §6.3). RoomCare must confirm it accepts this payload, or provide its own cleaning-task endpoint. |
| R2 | Signed client calls to `POST /housekeeping/cleaning-status` for every task status change | **Required** | Defined by the FrontDesk (§4.2) |
| R3 | API documentation: base URL, authentication header and credential | Required for room sync | **To be defined by RoomCare** |
| R4 | **Create room** endpoint, returning RoomCare's room id | Required for room sync | **To be defined by RoomCare** |
| R5 | **Update room** endpoint addressed by RoomCare room id, with supported fields | Required for room sync | **To be defined by RoomCare** |
| R6 | **Deactivate room** endpoint or flag (no hard delete) | Required for room sync | **To be defined by RoomCare** |
| R7 | Duplicate protection on create (`Idempotency-Key` or lookup by FrontDesk room id) | Required for room sync | **To be defined by RoomCare** |

Until B4–B8 and R3–R7 are delivered, the FrontDesk adapters stay contract-pending and room changes queue as `BLOCKED`. Once a contract arrives, only [integrations/roomSync/adapters.js](../integrations/roomSync/adapters.js) needs to be implemented; blocked jobs are re-queued automatically.

---

## 10. Information and credentials still needed from each developer

Exchange secrets over a private channel only, never by email in plain text and never in a repository.

### Restaurant POS developer

- [ ] Restaurant / branch id(s) the POS will send as `restaurant_id` (for `POS_RESTAURANT_IDS`), or confirmation that it is a single restaurant (default `MAIN`).
- [ ] Confirmation of how the POS will obtain `reservation_id` / `reservation_code` (`GET /pos/in-house` and/or the `GuestCheckedIn` webhook).
- [ ] Webhook receiver URL (HTTPS) for `POS_WEBHOOK_URL`.
- [ ] Whether the POS will sign its requests. If yes, the FrontDesk admin generates `POS_INBOUND_SECRET` and shares it.
- [ ] A test environment/contact for an end-to-end test against a running FrontDesk.
- **The FrontDesk admin will issue:** `POS_API_KEY`, `POS_WEBHOOK_SECRET` (and `POS_INBOUND_SECRET` if signing).

### OnlineBooking (StayBook) developer

- [ ] StayBook `hotel.id` for this hotel (for `STAYBOOK_HOTEL_ID`).
- [ ] The StayBook room list (`rooms.id` + room number) so the FrontDesk admin can map each room.
- [ ] Webhook receiver URL (HTTPS) for `BOOKING_WEBHOOK_URL`.
- [ ] Whether StayBook will sign its requests (`BOOKING_INBOUND_SECRET`).
- [ ] Room API contract and credential (§9.2 B4–B8): base URL for `STAYBOOK_API_URL`, token for `STAYBOOK_API_TOKEN`, header format, field rules (room type values, price/currency, amenities format), error format and which statuses are safe to retry.
- **The FrontDesk admin will issue:** `BOOKING_API_KEY`, `BOOKING_WEBHOOK_SECRET` (and `BOOKING_INBOUND_SECRET` if signing).

### RoomCare developer

- [ ] **Confirmation that RoomCare is the Housekeeping System (Member 3)** and will use the `HOUSEKEEPING_*` credentials, or a correction if it is a separate system.
- [ ] Webhook receiver URL (HTTPS) for `HOUSEKEEPING_WEBHOOK_URL`, and confirmation that it accepts the `RoomVacated` payload in §6.3.
- [ ] Confirmation that RoomCare will report status with `POST /housekeeping/cleaning-status`, identifying rooms by FrontDesk `room_id` / `room_number`, and signing every write.
- [ ] Room API contract and credential (§9.3 R3–R7): base URL for `ROOMCARE_API_URL`, token for `ROOMCARE_API_TOKEN`.
- **The FrontDesk admin will issue:** `HOUSEKEEPING_API_KEY`, `HOUSEKEEPING_INBOUND_SECRET` (**mandatory**: without it every RoomCare write gets `503`), `HOUSEKEEPING_WEBHOOK_SECRET`.
