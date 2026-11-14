# Integration guide: POS and Hotel Reservation System

The POS and the Hotel Reservation System are **separate applications** that are not part of this project. This guide is for the developer who connects one of them to the PMS. No change to the PMS core is needed: you configure keys in `.env` and call the endpoints below.

```
Base URL:  https://<pms-host>/api/v1/integrations
           ├── /pos/...            POS system
           └── /reservations/...   Hotel Reservation System
```

## 1. Common rules

### Authentication
Each system has its own key. A POS key can't call reservation endpoints, and the reverse.

```
X-Api-Key: <key>           (or)   Authorization: Bearer <key>
```

Configure on the PMS server (`.env`):

```dotenv
POS_API_KEY=<long random string>
RESERVATION_API_KEY=<long random string>
```

An empty key disables that integration (503 `INTEGRATION_DISABLED`). Generate keys with, for example, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Idempotency: required on every POST / PATCH
```
Idempotency-Key: <8-100 chars: letters, digits, . _ : ->   e.g. a UUID per logical operation
```
| Situation | Result |
|---|---|
| First request | Processed; response stored |
| Network retry with the **same key and same body** | Original response replayed, header `Idempotent-Replayed: true` |
| Same key, **different body** | 422 `IDEMPOTENCY_KEY_REUSED` |
| Same key while the first call is still running | 409 `REQUEST_IN_PROGRESS` (retry shortly) |
| 5xx | Not stored, so it's safe to retry with the same key |

There is also natural duplicate protection, which works even with a new key:
- A second charge with the same `externalTransactionId` returns 409 `DUPLICATE_TRANSACTION`.
- A second booking with the same `externalReservationId` returns 409 `DUPLICATE_RESERVATION`.

### Other rules
- **Rate limit:** `INTEGRATION_RATE_LIMIT_PER_MINUTE` (default 120) per system per IP. Over the limit you get 429 with a `Retry-After` header.
- **Responses** use the same envelope as the staff API: `{ "success": true, "data": … }` or `{ "success": false, "error": { "code", "message", "details" } }`. Validation errors are 422 with per-field `details`.
- **Privacy:** integration responses contain references and statuses only. Guest contact details and ID data are never returned.
- **Audit:** every accepted write is logged in `integration_requests`, visible in Admin Console → Integrations.

## 2. Hotel Reservation System

### Workflow
1. `GET /reservations/room-types` and `GET /reservations/availability`: show what can be booked.
2. `POST /reservations`: send the booking. The PMS validates room type, dates, capacity and per-night availability (row-locked), stores your `externalReservationId`, and returns the PMS reservation code.
3. The front desk sees the booking under Reservations (source "Online"), assigns a room on arrival, verifies identity and checks the guest in.
4. Changes and cancellations: `PATCH /reservations/{externalReservationId}`, `POST /reservations/{externalReservationId}/cancel`. Allowed only while the booking is still CONFIRMED (not yet checked in).
5. The PMS notifies you of check-in, checkout and front-desk changes (for example a room being assigned) through webhooks (section 4). Cancellations come from your system; the front desk does not cancel online bookings.

### Endpoints
| Method | Path | Body / query |
|---|---|---|
| GET | `/reservations/room-types` | none |
| GET | `/reservations/availability?checkInDate&checkOutDate[&roomType]` | none |
| POST | `/reservations` | booking (below) |
| GET | `/reservations/{externalReservationId}` | none |
| PATCH | `/reservations/{externalReservationId}` | any of `checkInDate`, `checkOutDate`, `roomType`, `numGuests`, `paymentStatus`, `bookingReference`, `notes`, `guest{…}` |
| POST | `/reservations/{externalReservationId}/cancel` | `{ "reason": "…" }` |

```http
POST /api/v1/integrations/reservations
X-Api-Key: <RESERVATION_API_KEY>
Idempotency-Key: 3f6c1a2e-6a0b-4a51-9a0e-1c1d2f3a4b5c
Content-Type: application/json

{
  "externalReservationId": "HRS-1001",
  "bookingReference": "BK-7781",
  "guest": { "firstName": "Maria", "lastName": "Santos", "email": "maria@example.com", "phone": "+63 917 555 0101" },
  "roomType": "Deluxe",
  "checkInDate": "2026-11-20",
  "checkOutDate": "2026-11-22",
  "numGuests": 2,
  "paymentStatus": "PREPAID",
  "notes": "Late arrival"
}
```
```json
HTTP/1.1 201 Created
{ "success": true, "data": {
  "externalReservationId": "HRS-1001", "bookingReference": "BK-7781", "pmsReservationCode": "RSV-0007",
  "status": "CONFIRMED", "roomType": "Deluxe", "roomNumber": null,
  "checkInDate": "2026-11-20", "checkOutDate": "2026-11-22", "numGuests": 2,
  "paymentStatus": "PREPAID", "cancelledAt": null, "lastSyncedAt": "2026-11-06T06:40:12.000Z" } }
```

| Field | Rules |
|---|---|
| `externalReservationId` | Required, ≤ 100 chars, `[A-Za-z0-9._:-]`, unique per system |
| `guest.firstName` / `guest.lastName` | Required. `email` and `phone` are optional. An existing guest is matched by email, or phone + last name |
| `roomType` | Must exist (see `/room-types`) |
| `checkInDate` / `checkOutDate` | `YYYY-MM-DD`; check-in not in the past; check-out after check-in; at most 60 nights |
| `numGuests` | 1–20, within the room type's capacity |
| `paymentStatus` | `UNPAID`, `DEPOSIT_PAID`, `PREPAID` or `REFUNDED`. Shown to the front desk for information only; the guest still settles the final bill at checkout |

Common errors:
- 409 `NO_AVAILABILITY` (sold out for at least one night)
- 409 `DUPLICATE_RESERVATION` (`error.details` holds the existing booking)
- 409 `RESERVATION_NOT_MODIFIABLE` (already checked in or out, or cancelled)
- 422 for an unknown room type or invalid dates

## 3. POS: posting charges to a room

### Workflow
1. The guest orders at the restaurant or bar and asks to "charge to room".
2. The POS looks up the room: `GET /pos/in-house?roomNumber=204` returns `folioId`, a masked name (`"M. Santos"`) and `folioOpen`.
3. The POS posts the charge: `POST /pos/charges`. You can cross-check with `folioId` and/or `guestLastName`.
4. The charge appears on the guest's folio. When the front desk generates the final bill, room charges and POS charges are totalled together (`v_bill_total`).
5. Once the front desk **confirms** the final bill (checkout in progress), the folio is closed: further charges get 409 `FOLIO_CLOSED` and must be settled at the POS. Corrections to posted charges are made by the front desk as a bill adjustment.

### Endpoints
| Method | Path | Notes |
|---|---|---|
| GET | `/pos/in-house?roomNumber=` | 404 `NO_IN_HOUSE_GUEST` if the room has no checked-in guest |
| POST | `/pos/charges` | Post a charge |
| GET | `/pos/charges/{externalTransactionId}` | Check that a charge was recorded (sync status) |

```http
POST /api/v1/integrations/pos/charges
X-Api-Key: <POS_API_KEY>
Idempotency-Key: pos-terminal-3-txn-000123
Content-Type: application/json

{
  "externalTransactionId": "POS-TXN-000123",
  "roomNumber": "204",
  "folioId": 12,
  "guestLastName": "Santos",
  "outlet": "Lobby Restaurant",
  "category": "FOOD",
  "description": "Dinner for two",
  "amount": 850.50,
  "currency": "PHP",
  "transactionAt": "2026-11-06T19:42:00+08:00",
  "items": [
    { "name": "Chicken adobo", "quantity": 2, "unitPrice": 320.25 },
    { "name": "Iced tea", "quantity": 2, "unitPrice": 105.00 }
  ]
}
```
```json
HTTP/1.1 201 Created
{ "success": true, "data": { "pmsChargeId": 5, "externalTransactionId": "POS-TXN-000123", "folioId": 12, "roomNumber": "204",
  "category": "FOOD", "description": "Dinner for two", "amount": 850.5, "transactionAt": "2026-11-06T11:42:00.000Z", "postedAt": "2026-11-06T11:42:03.000Z" } }
```
- `category` is one of `FOOD`, `BEVERAGE`, `MINIBAR`, `LAUNDRY`, `SPA`, `SERVICE`, `OTHER`.
- `amount` is greater than 0 with at most 2 decimals. If `items` are sent, they must add up to `amount`.
- `transactionAt` can't be in the future.

Common errors:
- 404 `NO_IN_HOUSE_GUEST`
- 409 `GUEST_MISMATCH` / `FOLIO_MISMATCH` (the cross-check failed)
- 409 `FOLIO_CLOSED`
- 409 `DUPLICATE_TRANSACTION`

## 4. Webhooks (PMS → external system)

Set a URL and a secret per system in `.env`:

```dotenv
RESERVATION_WEBHOOK_URL=https://booking.example.com/webhooks/pms
RESERVATION_WEBHOOK_SECRET=<shared secret>
POS_WEBHOOK_URL=https://pos.example.com/webhooks/pms
POS_WEBHOOK_SECRET=<shared secret>
```

| Receiver | Events | When |
|---|---|---|
| Reservation System | `reservation.checked_in`, `reservation.checked_out`, `reservation.updated` (e.g. room assigned) | Only for bookings it created. Changes it made itself (its own PATCH / cancel) are not echoed back |
| POS | `stay.checked_in`, `stay.checked_out` | Every check-in and checkout, so the POS knows which rooms can be charged |

Delivery:
- `POST <url>` with a JSON body.
- 2xx means delivered. Anything else is retried with exponential backoff (30 s, 1 min, 2 min … up to 1 h) for `INTEGRATION_OUTBOX_MAX_ATTEMPTS` attempts (default 8), then marked FAILED.
- An administrator can re-send from Admin Console → Integrations.
- Events are written in the same database transaction as the change, so an event is never sent for a change that was rolled back. Delivery is at-least-once: de-duplicate on `X-PMS-Delivery` / `id`.

```http
POST /webhooks/pms
Content-Type: application/json
X-PMS-Event: reservation.checked_out
X-PMS-Delivery: 42
X-PMS-Timestamp: 1793952000
X-PMS-Signature: sha256=5d1c…

{ "id": 42, "event": "reservation.checked_out", "createdAt": "2026-11-06T03:20:00.000Z",
  "data": { "origin": "PMS", "reservationCode": "RSV-0007", "source": "RESERVATION_SYSTEM", "externalReservationId": "HRS-1001",
            "bookingReference": "BK-7781", "status": "CHECKED_OUT", "roomType": "Deluxe", "roomNumber": "204",
            "checkInDate": "2026-11-20", "checkOutDate": "2026-11-22", "numGuests": 2, "occurredAt": "2026-11-22T03:20:00.000Z" } }
```

The POS `stay.*` payload contains `folioId`, `reservationCode`, `roomNumber`, `guestDisplayName` (masked), `checkInAt`, `checkOutAt`, `status` and `occurredAt`.

Verify the signature (Node.js example):

```js
import crypto from "crypto";
function verify(rawBody, headers, secret) {
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${headers["x-pms-timestamp"]}.${rawBody}`).digest("hex");
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headers["x-pms-signature"] || ""));
  const fresh = Math.abs(Date.now() / 1000 - Number(headers["x-pms-timestamp"])) < 300; // reject replays older than 5 min
  return ok && fresh;
}
```

## 5. Payment gateway adapter

Card and e-wallet payments go through `integrations/paymentGateway`. The Payment module only calls:

```js
authorize({ amount, currency, method, paymentToken, reference }) // → { approved, reference?, reason? }
```

To connect a real provider:
1. Add `integrations/paymentGateway/<provider>Gateway.js` implementing `authorize`.
2. Register it in `integrations/paymentGateway/index.js`.
3. Set `PAYMENT_GATEWAY_DRIVER=<provider>`.

Card numbers never reach the PMS: the terminal or hosted form gives a one-time `paymentToken`. Timeouts and errors are treated as declines, never as success. The `sandbox` driver (`tok_approve…` / `tok_decline…`) is for development and training, and the server refuses it in production.

## 6. Testing an integration

- **Postman:** import `docs/postman/HotelFrontDesk-PMS.postman_collection.json` and set `baseUrl`, `posApiKey` and `reservationApiKey`.
- **Automated:** `npm test` runs `__tests__/integrations.test.js`, which simulates both systems end to end. It covers duplicates, idempotent retries, invalid payloads, a wrong or missing key, overbooking, folio closing, and a local webhook receiver that verifies the signature.
