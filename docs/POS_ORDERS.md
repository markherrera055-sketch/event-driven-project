# Restaurant POS → Frontdesk: purchase notifications with front-desk review

This guide is for the **Restaurant POS developer** (Member 4) and for the hotel's **administrator / front desk**. It describes how the restaurant's own POS tells Frontdesk about a hotel guest's purchase, how the front desk checks it and adds it to the guest's bill, and how both systems stay in sync.

> **In one sentence:** the POS sends `POST /api/v1/integrations/pos/orders` when a hotel guest's order is completed; Frontdesk queues it for review; a receptionist verifies the guest and adds it to their folio as an **outstanding charge** (or rejects it); the guest pays room + restaurant together at checkout; the POS is told the outcome by webhook.

Frontdesk does **not** contain a POS and never changes or deletes the POS's transactions. This is a **billing** integration, not a payment integration.

---

## 1. Existing architecture and compatibility

| Area | What already existed | How this integration uses it |
|---|---|---|
| Guest folio | `stay_charges` table, `folioService.postFolioCharge()` (locks the bill, refuses a closed folio, publishes `RoomChargePosted` / `GuestFolioUpdated`) | Approved purchases are posted through this same function. **No second billing system.** |
| Bill and checkout | `v_bill_total` view = room charge + folio charges + adjustments; receipt lists folio charges | A FOOD / BEVERAGE folio charge automatically appears under *Restaurant charges*, on the final bill, the receipt and the checkout folio summary. Billing arithmetic was not changed. |
| Payments | `paymentService` – full payment of the confirmed bill only | Untouched. Receiving or approving a POS purchase never creates a payment. |
| Integration security | Per-system API keys + scopes, HMAC request signing with timestamp window, mandatory `Idempotency-Key` with stored replies, rate limits, HTTPS enforcement | Reused as-is. Two new scopes for the POS key: `pos_orders:write`, `pos_orders:read`. |
| Events / webhooks | Transactional outbox, signed webhooks with retries | New event `PosOrderReviewed` delivered to the POS. |
| Staff roles | `RECEPTIONIST` (front-desk + billing), `ADMINISTRATOR` (rooms, staff, integrations) | Viewing: all staff. Approve / reject: **receptionists only**, like every other billing action. |
| Notifications | Dashboard notices computed on load; no push channel | Purchases are the notifications (one row per order, so duplicates are impossible). Bell + sidebar badge poll every 30 s. |
| Legacy POS endpoint | `POST /pos/room-charges` posts straight to the folio (strict match, no staff review) | **Kept unchanged and marked deprecated** (`Deprecation: true` header). Both paths refuse an order already charged through the other. |
| StayBook integration | `/integrations/staybook/*` (uncommitted work in progress) | Not touched; its tests still pass. |

---

## 2. Integration architecture

```
Restaurant POS ──POST /integrations/pos/orders──► API key → (HMAC signature) → Idempotency-Key → scope
                                                  │  validate → match guest → store pos_orders row (unique per restaurant + order id)
                                                  ▼
                       pos_orders.status = PENDING_REVIEW | NEEDS_GUEST_VERIFICATION | ALREADY_PAID
                                                  │
                     Front desk: bell / sidebar badge (30 s polling), dashboard notice, "Restaurant charges" page,
                                 "Restaurant purchases" card on the guest folio
                                                  │
      Receptionist "Add to folio" ──► ONE transaction: lock order, stay, bill → postFolioCharge() → ADDED_TO_FOLIO
      Receptionist "Reject" + reason ────────────────────────────────────────────────────────────► REJECTED
                                                  │
                     outbox ──signed webhook──► POS: PosOrderReviewed   (POS can also poll GET /pos/orders/{restaurant}/{order})
```

### Statuses

| Status | Meaning | Billed? |
|---|---|---|
| `PENDING_REVIEW` | Reservation identified, every value the POS sent agrees, guest in-house, folio open. Waiting for a receptionist. | Not yet |
| `NEEDS_GUEST_VERIFICATION` | The guest could not be identified with certainty (see `verification_reasons`). A receptionist must choose the stay and write a verification note. | Not yet |
| `ADDED_TO_FOLIO` | Approved: an outstanding charge on the guest's folio, paid at checkout. | Yes, once |
| `REJECTED` | Rejected by staff (with reason), or voided by the POS before review. | Never |
| `ALREADY_PAID` | The restaurant collected payment itself (`payment_status: PAID`). Kept for information only. | Never |

There is no resting `APPROVED` status: approving and posting to the folio happen in the same transaction, so an approved purchase is always `ADDED_TO_FOLIO`.

### Guest matching (never by room number or name alone)

The reliable identifier is the **Frontdesk reservation** – `reservation_id` or `reservation_code` – which the POS gets from `GET /pos/in-house?room_number=` or from the `GuestCheckedIn` webhook. `guest_id`, `room_number` and `customer_name` are cross-checks.

An order is `PENDING_REVIEW` (with a suggested stay) only when **all** of these hold; otherwise it is `NEEDS_GUEST_VERIFICATION` with the reasons:

| Reason | When |
|---|---|
| `NO_RESERVATION_REFERENCE` | Neither `reservation_id` nor `reservation_code` was sent (room / name alone are not trusted) |
| `RESERVATION_NOT_FOUND` | The reference does not exist |
| `RESERVATION_REFERENCE_MISMATCH` | `reservation_id` and `reservation_code` belong to different reservations |
| `GUEST_ID_MISMATCH` | `guest_id` is not the reservation's guest |
| `NOT_IN_HOUSE` | The reservation is not checked in (future, cancelled or checked out) |
| `ROOM_MISMATCH` | `room_number` is not the reservation's current room |
| `NAME_MISMATCH` | `customer_name` does not match the registered guest ("John Doe", "Doe, John", "J. Doe" match John Doe) |
| `ORDERED_BEFORE_CHECK_IN` | `ordered_at` is before the guest checked in |
| `FOLIO_CLOSED` | The guest's bill is already confirmed for checkout – must be settled at the restaurant |

Matching is only a suggestion. At approval Frontdesk re-checks, under row locks, that the chosen stay is in-house and its folio open.

---

## 3. API for the Restaurant POS developer

Base URL: `https://<frontdesk-host>/api/v1/integrations/pos`

### 3.1 Headers

| Header | Required | Notes |
|---|---|---|
| `X-Api-Key: <POS key>` (or `Authorization: Bearer <POS key>`) | always | Issued by the hotel administrator |
| `Idempotency-Key` | on POST | 8–100 chars `[A-Za-z0-9._:-]`, unique per logical send. Recommended: `pos-{restaurant_id}-{order_id}-{status}` |
| `Content-Type: application/json` | on POST | |
| `X-Timestamp`, `X-Signature` | when the hotel set `POS_INBOUND_SECRET` | `X-Signature = "sha256=" + hex(HMAC_SHA256(secret, X-Timestamp + "." + rawBody))`, `X-Timestamp` = Unix seconds; refused outside ±300 s (replay protection). See INTEGRATIONS.md §2.4 |

### 3.2 `POST /orders` – notify a completed order

```http
POST /api/v1/integrations/pos/orders
X-Api-Key: <POS key>
Idempotency-Key: pos-R1-ORD-10001-COMPLETED
X-Timestamp: 1796202000
X-Signature: sha256=5b1f…
Content-Type: application/json

{
  "external_order_id": "ORD-10001",
  "restaurant_id": "R1",
  "outlet_name": "Lobby Restaurant",
  "customer_name": "John Doe",
  "reservation_code": "RSV-0007",
  "guest_id": 12,
  "room_number": "204",
  "items": [
    { "sku": "F-12", "name": "Club sandwich", "description": "No onions", "category": "FOOD", "quantity": 2, "unit_price": 350.00 },
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

**202 Accepted** – new order, queued for the front desk:

```json
{ "success": true, "data": {
  "order_ref": "PO-000031", "restaurant_id": "R1", "external_order_id": "ORD-10001",
  "status": "PENDING_REVIEW", "verification_reasons": [],
  "reservation_id": 7, "reservation_code": "RSV-0007", "room_number": "204", "guest_display_name": "J. Doe",
  "total": 880, "currency": "PHP", "payment_status": "CHARGE_TO_ROOM", "order_status": "COMPLETED",
  "charge_id": null, "received_at": "2026-12-02T05:00:01.000Z", "reviewed_at": null,
  "rejection_reason": null, "voided_at": null, "duplicate": false } }
```

Uncertain match – still **202**, no reservation details disclosed:

```json
{ "success": true, "data": { "order_ref": "PO-000032", "status": "NEEDS_GUEST_VERIFICATION",
  "verification_reasons": ["ROOM_MISMATCH"], "reservation_id": null, "reservation_code": null,
  "room_number": null, "guest_display_name": null, "total": 880, "duplicate": false, "…": "…" } }
```

Re-delivery of the same order (webhook retry under a new `Idempotency-Key`) – **200**, `"duplicate": true`, current status, nothing created. A retry with the *same* `Idempotency-Key` gets the original stored response with header `Idempotent-Replayed: true`.

#### Fields

| Field | Rules |
|---|---|
| `external_order_id` | **Required.** The POS's order id, ≤ 64 chars `[A-Za-z0-9._:-]`. Unique per restaurant – never reuse it for another order |
| `restaurant_id` | Optional, ≤ 40 chars `[A-Za-z0-9._:-]`. Defaults to `POS_DEFAULT_RESTAURANT_ID` (`MAIN`). Must be in `POS_RESTAURANT_IDS` when the hotel set that list |
| `outlet_name` | Optional, ≤ 80 – shown on the folio ("Lobby Restaurant") |
| `reservation_code` / `reservation_id` | **Strongly recommended – without one the order always needs manual verification.** Get them from `GET /pos/in-house?room_number=` or the `GuestCheckedIn` webhook |
| `guest_id`, `room_number`, `customer_name` | Optional cross-checks (Frontdesk guest id from `GuestCheckedIn`, room, name as the cashier typed it) |
| `items[]` | **Required**, 1–100: `name` (req, ≤100), `quantity` (req, 1–1000), `unit_price` (req, ≥ 0, 2 decimals), optional `sku`, `description` (≤255), `category` (`FOOD` / `BEVERAGE`) |
| `subtotal` | **Required** = Σ `quantity × unit_price` |
| `service_charge`, `tax`, `discount` | Optional, ≥ 0, default 0 |
| `total` | **Required**, > 0, = `subtotal + service_charge + tax − discount` |
| `currency` | **Required**, must be the hotel currency (`PHP`) |
| `ordered_at` | **Required** ISO-8601 with offset; not more than 5 min in the future |
| `payment_status` | **Required**: `CHARGE_TO_ROOM` or `UNPAID` (bill it to the room), `PAID` (restaurant collected – recorded as `ALREADY_PAID`, never billed) |
| `order_status` | **Required**: `COMPLETED` for a new order; `VOIDED` only to void an order already sent (§3.4) |

Unknown fields are ignored.

### 3.3 `GET /orders/{restaurant_id}/{external_order_id}` – check the review status

```http
GET /api/v1/integrations/pos/orders/R1/ORD-10001
X-Api-Key: <POS key>
```
```json
{ "success": true, "data": { "order_ref": "PO-000031", "status": "ADDED_TO_FOLIO", "charge_id": 41,
  "reservation_code": "RSV-0007", "room_number": "204", "reviewed_at": "2026-12-02T05:03:12.000Z", "…": "…" } }
```

### 3.4 Voiding an order

Orders are immutable. To cancel one, send the **same body again with `"order_status": "VOIDED"`** (new `Idempotency-Key`). To change one, void it and send a new `external_order_id`.

| Frontdesk status when the void arrives | Result |
|---|---|
| `PENDING_REVIEW` / `NEEDS_GUEST_VERIFICATION` | → `REJECTED` ("Voided by the restaurant POS before review") |
| `ADDED_TO_FOLIO` | Folio is **not** changed automatically. The order is flagged; the front desk corrects the bill (adjustment, or refund if already paid) and marks the void handled |
| `REJECTED` / `ALREADY_PAID` | Recorded (`voided_at`), nothing else changes |

### 3.5 Errors

| HTTP | `code` | When | POS action |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Header missing / malformed | Fix and resend |
| 401 | `INVALID_API_KEY` | Missing / wrong key | Check configuration; do not retry blindly |
| 401 | `SIGNATURE_REQUIRED` / `INVALID_SIGNATURE` / `SIGNATURE_EXPIRED` | Signing on and the signature is missing, wrong, or the timestamp is > 300 s off | Fix clock / secret; re-sign with a fresh timestamp |
| 403 | `INSUFFICIENT_SCOPE` | A key of another system | Use the POS key |
| 403 | `HTTPS_REQUIRED` | Plain HTTP in production | Use HTTPS |
| 409 | `ORDER_CONFLICT` | Same order id re-sent with different content (`details` = stored order) | Void + new order id |
| 409 | `IDEMPOTENCY_KEY_REUSED` (422) / `REQUEST_IN_PROGRESS` | Key reused with another body / first request still running | New key / retry shortly |
| 422 | `VALIDATION_ERROR` | Field errors in `details` (amounts not adding up, currency, future time, unknown restaurant, new order sent as `VOIDED`, …) | Fix; do not retry unchanged |
| 429 | `RATE_LIMITED` | Too many requests | Back off |
| 5xx | – | Frontdesk unavailable | Retry with back-off **using the same Idempotency-Key** |

### 3.6 Webhook to the POS: `PosOrderReviewed`

Sent to `POS_WEBHOOK_URL`, signed like every Frontdesk webhook (`X-PMS-Timestamp`, `X-PMS-Signature`, see INTEGRATIONS.md §6). Deliveries are retried; de-duplicate on `event_id`.

```json
{ "event": "PosOrderReviewed", "event_id": "EVT-000123", "occurred_at": "2026-12-02T05:03:12.000Z",
  "pos_order_id": 31, "order_ref": "PO-000031", "restaurant_id": "R1", "external_order_id": "ORD-10001",
  "status": "REJECTED", "reservation_id": 7, "reservation_code": "RSV-0007", "stay_id": 5, "room_number": "204",
  "charge_id": null, "amount": 880, "currency": "PHP", "reviewed_at": "2026-12-02T05:03:12.000Z",
  "rejection_reason": "Guest says this is not their order" }
```

`status` is `ADDED_TO_FOLIO` or `REJECTED`. On `REJECTED`, the restaurant must collect payment from the customer directly. Payloads never contain guest names or contact data.

### 3.7 Legacy `POST /pos/room-charges` (deprecated)

Still works exactly as before (direct posting, strict match, documented in INTEGRATIONS.md §4) and now answers with `Deprecation: true`. New POS integrations should use `/orders`. An order is never billed twice across the two paths: approving an order already posted via `/room-charges` is refused, and `/room-charges` refuses an order id already added through review (409 `DUPLICATE_TRANSACTION`).

---

## 4. Database changes and migration plan

**One new table, `pos_orders`.** No existing table, column or view changes (`v_bill_total`, `stay_charges`, `bills`, `payments` are untouched).

| Column group | Columns |
|---|---|
| Identity | `id`, `source_system` ('POS'), `restaurant_id`, `external_order_id` – **unique (`source_system`, `restaurant_id`, `external_order_id`)** |
| As received | `outlet_name`, `customer_name`, `guest_reference`, `reservation_reference`, `room_number`, `items` (JSON), `subtotal`, `service_charge`, `tax`, `discount`, `total`, `currency`, `ordered_at`, `pos_payment_status`, `pos_order_status`, `content_hash` |
| Matching | `matched_reservation_id` → reservations, `matched_stay_id` → stays, `match_issues` (JSON) |
| Review | `status`, `stay_charge_id` → stay_charges (**unique**), `reviewed_by` → users, `reviewed_at`, `review_note`, `rejection_reason` |
| Sync | `received_at`, `last_delivery_at`, `delivery_count`, `processing_error`, `voided_at`, `needs_adjustment`, `adjustment_resolved_by` → users, `adjustment_resolved_at` |

Foreign keys use `ON DELETE RESTRICT` like the rest of the schema. The folio charge created on approval has `source_system = 'POS'` and `external_transaction_id = '<restaurant_id>:<external_order_id>'`, so the existing unique index on `stay_charges` is a final guard against double billing.

**Applying it**

1. Back up the database (`npm run backup`).
2. `npm run migrate` – non-destructive: `sequelize.sync()` creates only missing tables (here `pos_orders`), then the existing idempotent upgrades and the view. Existing data is not modified. **Never** use `--fresh` on a real database.
3. Verify: `SHOW CREATE TABLE pos_orders;` shows the unique key `uq_pos_order_external`.

Rollback: deploying the previous build is enough — the old code ignores the `pos_orders` table, and folio charges already approved stay on the guests' folios as normal POS charges. Keep the table for audit; drop it (`DROP TABLE pos_orders;`) only if no purchase was ever approved.

The migration has **not** been run against the development database as part of this change; the test suite uses its own `FrontDesk_test` database.

---

## 5. Notification and billing workflow (front desk)

1. **Notification** – the bell in the top bar and the counter next to **Restaurant charges** in the sidebar show how many purchases need attention (awaiting review, needing verification, voided after billing). A toast announces a new one. The dashboard shows a notice. Counts refresh every 30 s while the tab is visible.
2. **Open the purchase** – *Restaurant charges* lists purchases by status with customer, reservation, room, items, total and the POS order reference. Clicking one opens the detail: what the POS sent, the Frontdesk reservation it matched, any verification issues, the items and totals.
3. **Verify the guest** – the receptionist chooses the in-house stay (the suggested one is pre-selected for a certain match; candidates matching the reservation, room or name are listed first). A **verification note is required** for uncertain matches and when choosing a stay other than the suggested one.
4. **Add to folio** – one click posts the purchase to that guest's folio as an outstanding charge, recording the guest, reservation, POS order reference, items, amount, order time, approver and approval time. It appears immediately on the guest folio, the final bill and the receipt.
5. **Reject** – with a reason; the purchase is never billed; the POS is notified to collect payment.
6. **Checkout** – *Bill is correct — confirm* is **blocked** (409 `POS_ORDERS_PENDING`) while any purchase referring to the guest's reservation is still awaiting review, so nothing is missed. The guest then pays the combined total (room + restaurant + other charges + adjustments) in one payment.
7. **Already paid at the restaurant** – listed for information (*Paid at restaurant*), shown on the guest's folio page as "Not billed to the room", never added to the total.
8. **Voided after billing** – flagged in red; correct the bill with an adjustment, then *Mark void as handled*.

Administrators can see everything but cannot approve or reject (billing belongs to receptionists).

---

## 6. Security and duplicate prevention

**Security**

- API key per system (constant-time comparison), scoped: the POS key carries `pos_orders:write` / `pos_orders:read`; other systems' keys are refused (403).
- Optional HMAC-SHA256 request signing (`POS_INBOUND_SECRET`) with a ±300 s timestamp window: a captured request cannot be replayed later; within the window a replay is a duplicate and changes nothing. **Recommended for go-live**; the admin console warns while it is off.
- HTTPS enforced in production; rate limits per IP and per system.
- Secrets only in environment variables; the admin console shows configuration status, never keys.
- All input validated (whitelisted fields, types, amounts reconcile, currency, time bounds, allowed restaurants).
- Staff endpoints use the session + CSRF token; approve / reject / resolve are receptionist-only; the badge summary returns counts only.
- Responses to the POS contain a masked name (`J. Doe`) only once the order is tied to a stay; webhooks contain no names; logs contain ids and amounts only.

**Duplicate prevention**

| Layer | Guarantee |
|---|---|
| `Idempotency-Key` | Same key + same body → stored response replayed; same key + other body → 422 |
| Unique (`restaurant_id`, `external_order_id`) | Any number of deliveries → one `pos_orders` row, one notification. Concurrent first deliveries are decided by the index and retried as re-deliveries |
| `content_hash` | A re-delivery with changed content is refused (409) and recorded, never silently applied |
| Order row lock on approve | Concurrent approvals → exactly one succeeds |
| Unique `pos_orders.stay_charge_id` and unique `stay_charges` (`source_system`, `external_transaction_id`) | A purchase can only ever produce one folio charge |
| Cross-path check | `/orders` ↔ legacy `/room-charges` never bill the same order twice |

---

## 7. Automated tests

`__tests__/integrations.pos-orders.test.js` (real Express app, real MySQL `FrontDesk_test`, POS simulated): 55 tests –

- valid orders (code or id), 12 invalid-payload cases, unknown restaurant, default restaurant, void of an unknown order;
- missing / wrong key, other system's key, missing Idempotency-Key, signing on: unsigned, wrong secret, expired timestamp (replay), valid; POS key on the staff API;
- retried delivery (same key, new key), changed content, same id at another restaurant, 6 concurrent deliveries → one row;
- matching: room mismatch, name mismatch, room + name only, unknown reservation, not checked in, wrong guest id, id/code disagree, ordered before check-in;
- notifications: summary has counts only, signed-out 401, staff queue contents, dashboard notice, candidate stays, admin view-only (403 on approve / reject / resolve), CSRF;
- approve → folio charge linked to order / guest / reservation / approver, no payment, signed `PosOrderReviewed` webhook, POS status lookup; approve once only; note required for uncertain / different stay; reject with reason; 3 concurrent approvals → one charge; already paid never billed; void before review / after billing; legacy path duplicates both ways;
- checkout: confirmation blocked while purchases are pending (including uncertain ones), combined bill 2500 + 880 = 3380, no partial payment, receipt lists the purchase, checkout folio balance 0; purchase after checkout refused; purchase after bill confirmation flagged `FOLIO_CLOSED` and refused.

Run: `npm test` (all suites) or `npx jest __tests__/integrations.pos-orders.test.js` with `--experimental-vm-modules` as in `package.json`.

---

## 8. Setup for the external POS developer

**Hotel administrator (Frontdesk `.env`):**

```ini
POS_API_KEY=<long random value>              # give to the POS developer
POS_INBOUND_SECRET=<long random value>       # recommended: POS must sign requests
POS_WEBHOOK_URL=https://pos.example/webhooks/frontdesk
POS_WEBHOOK_SECRET=<long random value>       # POS verifies Frontdesk's webhooks
POS_RESTAURANT_IDS=R1,R2                     # optional allow-list of restaurant / branch ids
POS_DEFAULT_RESTAURANT_ID=MAIN               # used when the POS sends no restaurant_id
```
Restart Frontdesk; check *Admin Console → Integrations → Restaurant POS purchases*.

**POS developer:**

1. Store the API key, inbound secret and webhook secret in your server's secret storage (never in the browser / client app).
2. At *charge to room*, look up the guest: `GET /pos/in-house?room_number=204` → `reservation_id`, `reservation_code`, masked name, `folio_open`. Show the masked name to the cashier to confirm. (Or keep the data from the `GuestCheckedIn` webhook.)
3. When the order is completed, `POST /orders` with `reservation_code` (or `reservation_id`), items and totals, from your **backend**. Use a stable `Idempotency-Key` per send and retry 5xx / timeouts with the same key and exponential back-off.
4. If the guest pays at the restaurant, still send the order with `payment_status: PAID` (informational) – or don't send it at all.
5. Handle `PosOrderReviewed` webhooks (verify `X-PMS-Signature`, de-duplicate on `event_id`, answer 2xx within 10 s). On `REJECTED`, collect payment from the customer. Alternatively poll `GET /orders/{restaurant_id}/{order_id}`.
6. To cancel, re-send the same order with `order_status: VOIDED`.
7. Test against the Frontdesk staging server with the Postman collection / `curl`, including a retry, a void and a rejected order.

---

## 9. Manual testing and go-live checklist

**Manual test (staging)**

- [ ] Check in a test guest; `GET /pos/in-house?room_number=` returns their reservation and masked name.
- [ ] `POST /orders` with the reservation code → 202 `PENDING_REVIEW`; bell and sidebar counter show 1 within 30 s; dashboard notice visible.
- [ ] Re-send the same body twice (new keys) → 200 `duplicate: true`; still one entry, counter unchanged.
- [ ] Open it as a receptionist → *Add to folio* → guest folio shows the restaurant line; no payment recorded; POS receives `PosOrderReviewed` `ADDED_TO_FOLIO`.
- [ ] Send an order with a wrong room → `NEEDS_GUEST_VERIFICATION`; approving without a note is refused; reject it with a reason → POS receives `REJECTED`.
- [ ] Send an order with `payment_status: PAID` → *Paid at restaurant*, not on the bill.
- [ ] Leave one order pending, generate the bill, try to confirm → blocked with "waiting for review"; approve it → confirm → total = room + restaurant; pay; receipt lists the restaurant order; checkout.
- [ ] Void an approved order → flagged "Voided after billing"; add an adjustment; *Mark void as handled*.
- [ ] Sign in as administrator → can view, cannot approve / reject.
- [ ] Wrong API key / unsigned request (when signing is on) → 401; check *Inbound requests* log in the admin console.

**Go-live**

- [ ] `npm test` green on the release build.
- [ ] Database backed up; `npm run migrate` run (creates `pos_orders`); unique key verified.
- [ ] Production `.env`: `POS_API_KEY`, `POS_INBOUND_SECRET`, `POS_WEBHOOK_URL`, `POS_WEBHOOK_SECRET`, `POS_RESTAURANT_IDS` set; `INTEGRATION_REQUIRE_HTTPS` on; `TRUST_PROXY=true` behind a TLS proxy.
- [ ] Admin console: POS *Enabled*, *Signed requests: Required (HMAC)*, webhooks configured and signed.
- [ ] POS and Frontdesk server clocks synchronised (NTP) – signatures are refused beyond ±300 s.
- [ ] POS sends from its backend only; secrets not in client apps or logs.
- [ ] Front-desk staff briefed: review queue, verification note, reject = restaurant collects, bill confirmation is blocked by pending purchases, voids after billing.
- [ ] Decide when to retire the legacy `POST /pos/room-charges` and tell the POS developer.
- [ ] Monitor the first days: *Outbound webhooks* (PosOrderReviewed delivered), *Inbound requests* (4xx rates), queue not growing unreviewed.
