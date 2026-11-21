# Room synchronisation and RoomCare cleaning integration

Frontdesk (PMS, Member 2) ↔ **OnlineBooking** (StayBook, Member 1) and **RoomCare**. These are separate applications with separate databases. They talk to each other only through HTTP APIs.

> **⚠ Unverified assumption: RoomCare = Housekeeping System (Member 3).** This document and the code treat RoomCare as the existing Housekeeping System (Member 3). RoomCare's cleaning callbacks therefore use the Housekeeping endpoints (`/api/v1/integrations/housekeeping/*`) and the `HOUSEKEEPING_*` credentials, and its cleaning notifications go to `HOUSEKEEPING_WEBHOOK_URL`. **Member 3 has not confirmed this.** Until they do:
> - Do not rename the Housekeeping integration, its scopes or its `HOUSEKEEPING_*` variables.
> - Do not issue separate RoomCare credentials.
> - Wherever this document says "RoomCare" about cleaning callbacks or webhooks, read it as "the Housekeeping System, assumed to be RoomCare".
>
> If Member 3 says RoomCare is a different system, RoomCare needs its own client entry (API key, inbound secret, scopes and webhook target) instead of reusing Housekeeping's.

> **Status (2026-11-21).** Everything on the Frontdesk side is implemented and tested. The outbound room create/update/deactivate calls are **waiting for API contracts**: OnlineBooking's documentation (`OnlineBooking-API-Documentation`) has no room endpoints and no server-to-server authentication, and no RoomCare API documentation exists yet. No endpoint, field name or auth scheme has been guessed. Room changes are queued as `BLOCKED` jobs and go out automatically once an adapter is implemented (§4).

| # | Feature | Frontdesk side | Works end-to-end today? |
|---|---|---|---|
| 1 | Room created → created in OnlineBooking and RoomCare | ✅ queue, mapping, retries, idempotency, monitoring | ⏳ needs both room API contracts (§4) |
| 2 | Checkout → RoomCare cleaning task | ✅ `RoomVacated` signed webhook (existing) + message, cleaning status, RoomCare room id, recorded response | ✅ if RoomCare accepts the webhook in [INTEGRATIONS.md §6](INTEGRATIONS.md#6-webhooks-pms--your-system); needs RoomCare's confirmation |
| 3 | RoomCare status → Frontdesk (PENDING / IN_PROGRESS / COMPLETED) | ✅ `POST /housekeeping/cleaning-status` (new) + existing endpoints; `GET /staybook/rooms` for OnlineBooking | ✅ if RoomCare calls these; needs RoomCare's confirmation |
| 4 | Room edited / deactivated / deleted → synced | ✅ same queue, coalesced edits; deletes become archive + deactivate | ⏳ needs both room API contracts |
| 5 | Integration monitoring | ✅ Admin Console → Integrations | ✅ |

---

## 1. Integration points in the existing Frontdesk

| Concern | Where | What was done |
|---|---|---|
| Room admin (create / edit / delete / restore) | `services/roomService.js` | Publishes `RoomCreated` / `RoomUpdated` (only when a field really changed, with the changed field names) / `RoomArchived` / `RoomRestored` **inside the room's DB transaction**. Create and restore now run in a transaction. A room known to an external system is archived instead of hard-deleted. |
| Domain events | `services/domainEvents.js`, `services/eventPayloads.js` | New catalogue events. `RoomVacated` gained `room_status`, `cleaning_status: "PENDING"` and `message`. These fields are additive, so existing receivers are unaffected. |
| Checkout | `services/checkoutService.js` | **Unchanged.** It already sets the room to `DIRTY` and publishes `RoomVacated` in the checkout transaction. Delivery is asynchronous through the outbox, so checkout never waits for RoomCare. |
| Room status rules | `services/roomStatusService.js`, `services/stayService.js` | A `DIRTY`/`CLEANING` room cannot be checked into (`ROOM_NOT_READY`). Only cleaning completion (or the front desk's "Mark clean") makes it ready. **Cleaning guard:** `rooms.cleaning_required` keeps the cleaning requirement through `MAINTENANCE`, so `DIRTY → MAINTENANCE → AVAILABLE` is refused (`409 ROOM_NEEDS_CLEANING`). So is any move to `AVAILABLE` while a cleaning task is still open. Cleaning reported while the room is under maintenance is recorded, and the room stays `MAINTENANCE` ([INTEGRATIONS.md §5](INTEGRATIONS.md#5-member-3-housekeeping-system)). |
| Inbound auth for RoomCare *(assumed = Housekeeping)* | `integrations/shared/auth.js` | **Reused.** On the assumption above, RoomCare uses `HOUSEKEEPING_API_KEY`, HMAC-signed writes (`HOUSEKEEPING_INBOUND_SECRET`), Idempotency-Key, rate limits and scopes. The secret is **mandatory** outside `NODE_ENV=test`. Without it, writes get `503 INBOUND_SIGNING_NOT_CONFIGURED`. |
| Webhook delivery | `integrations/shared/outbox.js`, `subscriptions.js` | Response body (first 1000 chars) is now stored. RoomCare deliveries carry `roomcare_room_id`. Health summary per receiver. |
| Room id mapping | `external_room_mappings` | **Reused** for both systems (`STAYBOOK`, new `ROOMCARE`). The StayBook mapping that reservations already use is the same mapping room sync fills in. |
| Room sync | `integrations/roomSync/` (new) | `roomSyncService.js` (queue + worker + admin), `adapters.js` (the only contract-specific code), `http.js` (timeouts, retry classification). |
| Monitoring | `controllers/api/adminController.js`, `public/js/pages/admin-integrations.js` | New sections on the existing Integrations page. |

## 2. Architecture

```
Admin edits a room ─► roomService (one DB transaction)
                        ├─ rooms row
                        ├─ integration_events  RoomUpdated (EVT-…)
                        └─ room_sync_jobs      one per configured target (re-used if one is open → edits coalesce)
                                   │
          room sync worker (ROOM_SYNC_INTERVAL_MS, FOR UPDATE SKIP LOCKED + lease)
                                   │  reads the room's CURRENT state
                ┌──────────────────┴──────────────────┐
     adapter STAYBOOK                         adapter ROOMCARE         ← contract-specific (adapters.js)
     no mapping → create (Idempotency-Key)    mapped → update          archived → deactivate (never delete)
                └─► external id saved in external_room_mappings ◄─┘
     2xx → SYNCED · network/timeout/408/425/429/5xx → retry with backoff · other 4xx or attempts exhausted → FAILED
     adapter not implemented / URL not set → BLOCKED (nothing sent), released automatically when ready

Guest checks out ─► checkoutService (one DB transaction): stay + reservation CHECKED_OUT, room DIRTY (VACANT_DIRTY),
                    RoomVacated event + outbox row ─► signed webhook to RoomCare (retries, at-least-once, event_id)
RoomCare ─► POST /api/v1/integrations/housekeeping/cleaning-status  (API key + HMAC + Idempotency-Key)
            PENDING → task linked · IN_PROGRESS → CLEANING · COMPLETED → AVAILABLE/RESERVED (VACANT_CLEAN), last_cleaned_at
OnlineBooking ─► GET /api/v1/integrations/staybook/rooms   (current status, ready_for_guest)
```

### Guarantees

- **Transaction consistency.** A room change and its sync jobs are committed together. A rolled-back change queues nothing, and a committed one is never lost.
- **No duplicates.** There is one open job per (room, system). Creates use a stable key `frontdesk:room:<id>:<system>:create`, so a retry after a lost answer reuses it. Adapters can also implement `findByFrontdeskId`. A mapping clash (the external system returns an id already mapped to another room) fails the job permanently and is never overwritten.
- **Independent failures.** Each system has its own job. One system being down never blocks the other, the Frontdesk transaction, or checkout.
- **Latest state wins.** Jobs carry no data. The room's state at send time is what goes out. An edit made while a request is in flight bumps the job's `version` and is sent next.
- **No hard deletes outside the Frontdesk.** Deleting a synced room archives it in the Frontdesk and sends `deactivate`. A room that never reached an external system is still deleted permanently, as before.

## 3. Status mapping

| Frontdesk `rooms.status` | `occupancy_status` (your terms) | Ready for a guest? |
|---|---|---|
| `AVAILABLE`, `RESERVED` | `VACANT_CLEAN` | yes |
| `DIRTY` (after checkout) | `VACANT_DIRTY` | **no** |
| `CLEANING` (RoomCare IN_PROGRESS) | `VACANT_DIRTY` | **no** |
| `OCCUPIED` | `OCCUPIED` | no |
| `MAINTENANCE` | `OUT_OF_ORDER` | no |

The stored statuses were **not renamed**: every existing integration, report and test depends on them. `occupancy_status` is derived and appears in room sync payloads, `GET /staybook/rooms` and the Admin Console.

| RoomCare task status | Frontdesk |
|---|---|
| `PENDING` | `housekeeping_tasks.status = OPEN`, room stays `DIRTY` |
| `IN_PROGRESS` | `IN_PROGRESS`, room `DIRTY → CLEANING` |
| `COMPLETED` | `COMPLETED`, room → `AVAILABLE` (or `RESERVED` if a reservation is assigned), `rooms.last_cleaned_at = completed_at`, `RoomCleaned` published |

## 4. What each team must provide (blocking items)

Implement the matching adapter in `integrations/roomSync/adapters.js` once these arrive. The interface is documented at the top of that file. Nothing else needs to change: queued `BLOCKED` jobs are released automatically.

### OnlineBooking (StayBook)

1. **Server-to-server authentication.** An API key or bearer token header. Today there is only session cookie + CSRF.
2. **Create room.** Method, path, request body, required fields, and a response containing StayBook's room id.
3. **Update room by StayBook room id.** Which fields can change: number, type, name, capacity, price, description, amenities, active flag.
4. **Deactivate / unpublish room**, or confirmation that an update with an inactive flag is the supported way. No hard delete.
5. **Duplicate protection.** `Idempotency-Key` honoured on create, or a lookup by `frontdesk_room_id`.
6. **Field rules.** Allowed room type values, how "Room Name" is formed (StayBook shows e.g. `Deluxe Room · 101`, which the Frontdesk does not store), price and currency format, amenities format, and the `hotel_id` to send.
7. **Error format** and which statuses are safe to retry.
8. *(Optional)* A way to receive status changes. Until then StayBook can poll `GET /api/v1/integrations/staybook/rooms`.

### RoomCare

0. **Identity.** Confirm that RoomCare *is* the Housekeeping System (Member 3). Until Member 3 confirms, this is an unverified assumption (see the note at the top).
1. **API documentation.** Base URL, authentication header and credential.
2. **Create room.** Request body, and a response containing RoomCare's room id.
3. **Update room by RoomCare room id**, and the supported fields.
4. **Deactivate room** (endpoint or flag). No hard delete.
5. **Duplicate protection** (Idempotency-Key or lookup by `frontdesk_room_id`).
6. **Cleaning notification.** Confirm that RoomCare accepts the existing signed `RoomVacated` webhook (verify `X-PMS-Signature`, de-duplicate on `event_id`), or give its own cleaning-task endpoint and payload.
7. **Status callbacks.** Confirm that RoomCare calls `POST /housekeeping/cleaning-status` (or the three existing endpoints), signed with `HOUSEKEEPING_INBOUND_SECRET`, with `external_task_id` and `room_id`/`room_number` (or `roomcare_room_id` support, if RoomCare cannot send Frontdesk ids).
8. Housekeeping staff notification is RoomCare's job. The webhook's `message` field carries the text: *"Room 205 needs cleaning. A guest has checked out. Please prepare the room for the next guest."*

## 5. Frontdesk API added

**`POST /api/v1/integrations/housekeeping/cleaning-status`** (Housekeeping System, assumed to be RoomCare; `HOUSEKEEPING_API_KEY`, HMAC signature with `HOUSEKEEPING_INBOUND_SECRET`, `Idempotency-Key`. The identifiers it accepts and the authentication rules are in [INTEGRATIONS.md §5](INTEGRATIONS.md#5-member-3-housekeeping-system).)

```json
{ "status": "PENDING",     "external_task_id": "RC-TASK-1", "room_number": "204", "event_id": "EVT-000042", "assigned_to": "HK-07" }
{ "status": "IN_PROGRESS", "external_task_id": "RC-TASK-1", "room_number": "204", "started_by": "HK-07", "started_at": "2026-12-03T11:30:00Z" }
{ "status": "COMPLETED",   "external_task_id": "RC-TASK-1", "room_number": "204", "completed_by": "HK-07", "completed_at": "2026-12-03T12:30:00Z" }
```

The rules, responses and errors are identical to `/cleaning-tasks`, `/cleaning-started` and `/cleaning-completed` ([INTEGRATIONS.md §5](INTEGRATIONS.md#5-member-3-housekeeping-system)), plus `cleaning_status` in the answer. A repeated request with the same Idempotency-Key replays the answer. A second completion under a new key returns `409 DUPLICATE_CLEANING_COMPLETION`.

**`GET /api/v1/integrations/staybook/rooms`** (OnlineBooking; `BOOKING_API_KEY`) returns every mapped room with `staybook_room_id`, `frontdesk_room_id`, `room_number`, `room_type`, `capacity`, `nightly_rate`, `description`, `amenities`, `in_service`, `room_status`, `occupancy_status`, `ready_for_guest`, `last_cleaned_at` and `status_changed_at`. Availability for dates is still `GET /rooms/available` (unchanged).

**`RoomVacated` webhook (to the Housekeeping webhook target, assumed to be RoomCare)** has these new fields: `room_status` (`DIRTY`), `cleaning_status` (`PENDING`), `message`, and `roomcare_room_id` (`null` until room sync maps the room). `RoomStatusChanged` and `RoomCleaned` sent to the same target also carry `roomcare_room_id`.

**Admin (staff session, Administrator, CSRF):** `GET /api/v1/admin/integrations/room-sync[?target&status&roomId]`, `POST …/room-sync/:id/retry`, `POST …/room-sync/resync {target}`, `GET …/cleaning-notifications`.

## 6. Configuration

```dotenv
# Room sync targets. A target is enabled when its URL is set (jobs are queued from then on).
STAYBOOK_API_URL=          # OnlineBooking API base URL (HTTPS in production)
STAYBOOK_API_TOKEN=        # credential OnlineBooking issues to the Frontdesk (header format: per contract)
ROOMCARE_API_URL=
ROOMCARE_API_TOKEN=
ROOM_SYNC_INTERVAL_MS=15000
ROOM_SYNC_MAX_ATTEMPTS=8
ROOM_SYNC_TIMEOUT_MS=10000
# RoomCare inbound + cleaning webhooks reuse the Housekeeping settings, on the UNVERIFIED assumption
# that RoomCare is the Housekeeping System (Member 3 has not confirmed this):
HOUSEKEEPING_API_KEY=  HOUSEKEEPING_INBOUND_SECRET=  HOUSEKEEPING_WEBHOOK_URL=  HOUSEKEEPING_WEBHOOK_SECRET=
# HOUSEKEEPING_INBOUND_SECRET is REQUIRED outside NODE_ENV=test (writes get 503 without it).
```

`npm run migrate` creates `room_sync_jobs` and adds `integration_outbox.last_response_body` and `rooms.cleaning_required`. All three changes are additive. `cleaning_required` is backfilled for rooms that are `DIRTY`/`CLEANING`, have an open cleaning task, or went into `MAINTENANCE` from `DIRTY`/`CLEANING`. When an API URL is first set for a system that already has rooms, use **Admin Console → Integrations → Sync all rooms**.

## 7. Monitoring (Admin Console → Integrations)

- **Per system (OnlineBooking, RoomCare):** connection status (`Connected`, `Errors`, `Awaiting API contract`, `Not configured`, `No requests yet`), derived from real traffic only (no invented "ping" call). Also: last successful sync, last attempt and error, rooms mapped, pending / blocked / failed / synced counts, webhook health, the list of missing contract items, and **Sync all rooms**.
- **Room synchronisation history:** status filter, operation, the change that triggered it, attempts, external id, HTTP status, last error, and **Retry** for failed or blocked jobs.
- **Cleaning notifications:** each checkout's `RoomVacated`, its delivery to RoomCare (status, attempts, HTTP answer, **Re-send**), the cleaning status RoomCare reported, and the room's current state.

## 8. Tests

`__tests__/integrations.roomsync.test.js` (29 tests, real MySQL, real HTTP). OnlineBooking and RoomCare are **simulated with a test-only contract** (`POST /rooms`, `PUT /rooms/:id`, `POST /rooms/:id/deactivate`) that exists only to exercise the Frontdesk side. It is not a proposal for the real API. Covered:

- real adapters send nothing (`BLOCKED`); the monitor shows the missing items
- create in both systems with id mapping; updates hit the mapped record; coalesced edits; no-op saves send nothing
- number change, deactivation, maintenance; delete → archive + deactivate (no delete); restore; sync all rooms
- one system down while the other succeeds; backoff; lost create answer → same Idempotency-Key → one external room
- retries exhausted → `FAILED`; 4xx → `FAILED` → admin retry; a failed job superseded by a new change; an edit during an in-flight request
- checkout while RoomCare is down (checkout succeeds, notification retried, response recorded); message, `event_id`, `roomcare_room_id`
- `cleaning-status` PENDING → IN_PROGRESS → COMPLETED; unsigned / wrong key / invalid payload refused; idempotent replay; duplicate completion
- OnlineBooking sees `ready_for_guest: false` while dirty and `true` after completion
- admin-only monitoring and CSRF
