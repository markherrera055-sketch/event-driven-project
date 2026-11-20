# Staff REST API: `/api/v1`

This API is used by the Front Desk Web App and the Admin Console. External systems use [the integration API](INTEGRATIONS.md) instead.

## Conventions

- **Auth:** session cookie from `POST /login` (form fields `username`, `password`, `_csrf`).
- **CSRF:** every non-GET request must send `X-CSRF-Token: <token>`. The token is in `<body data-csrf>` on every page and in `GET /api/v1/me` → `data.csrfToken`.
- **Roles:** **R** = Receptionist, **A** = Administrator, **R/A** = both.
- **Responses** use one envelope:

```json
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 25, "total": 3, "pages": 1 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid.", "details": { "numGuests": "Must be at least 1." } } }
```

| Status | Meaning |
|---|---|
| 200 / 201 | OK / created |
| 401 `UNAUTHORIZED` | Not signed in |
| 403 `FORBIDDEN` / `CSRF_TOKEN_INVALID` | Wrong role / missing CSRF token |
| 404 `NOT_FOUND` | Unknown id |
| 409 | Business rule refused the action. `code` explains why: `ROOM_NOT_ASSIGNED`, `IDENTITY_NOT_VERIFIED`, `ROOM_NOT_READY`, `ROOM_OCCUPIED`, `NO_AVAILABILITY`, `ROOM_UNAVAILABLE`, `BILL_NOT_CONFIRMED`, `BILL_LOCKED`, `AMOUNT_MISMATCH`, `BILL_ALREADY_PAID`, `BILL_NOT_PAID`, … |
| 422 `VALIDATION_ERROR` | Field errors in `error.details` |
| 500 | Unexpected; `error.details.reference` matches the server log line |

Dates are `YYYY-MM-DD` in the hotel timezone (`HOTEL_TIMEZONE`). Timestamps are ISO-8601. Money values are numbers with 2 decimals; requests may send them as numbers or strings like `"6500.00"`.

## Endpoints

### Session, dashboard, reports

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/me` | R/A | Current user, hotel settings, payment gateway mode, CSRF token |
| PUT | `/me/password` | R/A | Change **your own** password `{ currentPassword, newPassword, confirmPassword }`. Signs out your other sessions. 10 attempts / 15 min |
| GET | `/dashboard` | R/A | Room counts (vacant / occupied / needs cleaning), arrivals, departures, revenue today, recent payments, notifications |
| GET | `/reports/summary?from=&to=` | R/A | Occupancy per night, check-ins/outs, revenue by day and method, bill composition, cancellations, rooms cleaned (max 92 days; defaults to the last 7) |

### Reservations (1.0) and identity verification (2.0)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/reservations?view=&search=&status=&page=&limit=` | R/A | `view`: `arrivals`, `departures`, `in-house`, `upcoming`. `search`: code, guest name, room, external reference |
| GET | `/reservations/{id or code}` | R/A | Detail with guest, room, verification attempts, stay |
| POST | `/reservations` | R | Walk-in / phone reservation (CONFIRMED) |
| GET | `/reservations/{id}/assignable-rooms?allTypes=` | R | Rooms eligible for the stay dates (no overlapping booking, not under maintenance, not physically occupied, type not sold out). For an in-house guest: vacant and clean now |
| PUT | `/reservations/{id}/room` | R | Assign or change the room `{ "roomId": 3 }`. CONFIRMED: reassign (new room RESERVED, previous room AVAILABLE when nothing else is assigned to it). CHECKED_IN: room move (new room OCCUPIED, previous room DIRTY + `RoomVacated` to Housekeeping; refused once a bill exists). All checks repeated under row locks |
| GET | `/reservations/{id}/verifications` | R/A | Verification attempts |
| POST | `/verifications` | R | Record an ID check (returns VERIFIED or FAILED) |

```http
POST /api/v1/reservations
X-CSRF-Token: …
Content-Type: application/json

{ "guest": { "firstName": "Juan", "lastName": "Dela Cruz", "phone": "0917-000-0000", "email": "juan@example.com" },
  "roomType": "Deluxe", "checkInDate": "2026-10-28", "checkOutDate": "2026-10-30", "numGuests": 2 }
```
```json
{ "success": true, "data": { "id": 1, "reservationCode": "RSV-0001", "status": "CONFIRMED", "source": "FRONT_DESK",
  "roomType": "Deluxe", "checkInDate": "2026-10-28", "checkOutDate": "2026-10-30", "nights": 2, "numGuests": 2,
  "guest": { "id": 1, "fullName": "Juan Dela Cruz", "email": "juan@example.com", "phone": "0917-000-0000" },
  "room": null, "verifications": [], "identityVerified": false, "stay": null } }
```
An existing guest with the same email, or the same phone + last name, is reused rather than duplicated. Instead of `guest` you may send `"guestId": 1`, and instead of `roomType`, `"roomId": 3`.

```http
POST /api/v1/verifications
{ "reservationId": 1, "idType": "PASSPORT", "idNumberLast4": "A9Z8", "nameOnId": "JUAN MIGUEL DELA CRUZ",
  "expiryDate": "2031-05-01", "photoMatches": true }
```
```json
{ "success": true, "data": { "id": 2, "attemptNo": 2, "idType": "PASSPORT", "idNumberLast4": "A9Z8", "result": "VERIFIED", "failureReason": null } }
```
`idType` is one of `PASSPORT`, `DRIVERS_LICENSE`, `NATIONAL_ID`, `OTHER_GOVERNMENT_ID`. A failed attempt returns `"result": "FAILED"` with `failureReason`. Retry by posting again.

### Check-in and stays (3.0, 4.0)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/check-ins` | R | `{ "reservationId": 1 }` → stay (201) |
| GET | `/stays?status=IN_HOUSE\|CHECKED_OUT&search=` | R/A | In-house / past stays |
| GET | `/stays/{id}` | R/A | Folio: reservation, POS charges, bill with adjustments and payments, totals |
| GET | `/stays/{id}/folio` | R/A | Guest folio statement: `room` (nights × rate, `basis` ACCRUED_TO_DATE / BILLED), `lines` (ROOM, RESTAURANT, OTHER_CHARGE, ADJUSTMENT, PAYMENT; payments negative), `failedPayments`, `totals { roomCharges, restaurantCharges, otherCharges, adjustments, totalCharges, payments, balance }`, `folioOpen` |

### Billing (6.0, 7.0)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/bills` | R | `{ "stayId": 1 }`: generate or recalculate the DRAFT final bill; returns the folio |
| POST | `/bills/{id}/adjustments` | R | `{ "amount": "-500.00", "reason": "Rate correction" }` (DRAFT only) |
| POST | `/bills/{id}/confirm` | R | DRAFT → CONFIRMED (bill frozen, ready for payment) |
| GET | `/bills/{id}/totals` | R/A | `{ roomCharge, chargesTotal, adjustmentsTotal, totalDue }` from `v_bill_total` |
| GET | `/bills/{id}/payments` | R/A | All payment attempts |

### Payments, receipts, checkout (8.0, 9.0)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/payments` | R | `{ "billId", "method": "CASH\|CARD\|E_WALLET", "amount", "paymentToken"? }` |
| GET | `/receipts/{id}` | R/A | Printable receipt with itemised bill |
| POST | `/checkouts` | R | `{ "stayId": 1 }`: requires a PAID bill |

```http
POST /api/v1/payments
{ "billId": 1, "method": "CARD", "amount": 6500.00, "paymentToken": "tok_decline_test" }
```
```json
{ "success": true, "data": { "attemptNo": 1, "status": "FAILED", "failureReason": "Card declined by issuer", "receipt": null } }
```
```http
POST /api/v1/payments
{ "billId": 1, "method": "CASH", "amount": 6500.00 }
```
```json
{ "success": true, "data": { "attemptNo": 2, "status": "SUCCESSFUL", "amount": 6500, "receipt": { "id": 1, "receiptNo": "OR-000001" } } }
```
A declined payment is a normal business outcome (201 with `status: FAILED`), not an HTTP error. `amount` must equal the current total due, which protects against paying a stale bill. Card and e-wallet payments need the `paymentToken` returned by the terminal or e-wallet. With the **sandbox** gateway, `tok_approve…` approves and `tok_decline…` declines.

### Guests

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/guests?search=&page=` | R/A | Search by name, email or phone |
| GET | `/guests/{id}` | R/A | Profile + reservation history |
| PATCH | `/guests/{id}` | R | Update `firstName`, `lastName`, `email`, `phone` (send `""` to clear optional fields) |

### Rooms (Room Status module) and housekeeping

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/rooms?status=&roomType=&needsCleaning=&search=&includeInactive=&archived=` | R/A | Room board, including the current in-house guest, `displayStatus` and `reservedTonight`. `archived=true` lists deleted (archived) rooms only |
| GET | `/room-types` | R/A | Types with `roomTypeId`: count, capacity, rate range |
| GET | `/rooms/{id}` | R/A | One room |
| GET | `/rooms/{id}/status-history` | R/A | Latest 50 status transitions: from, to, reason, source, staff member, external reference |
| POST | `/rooms/{id}/clean` | R/A | Front-desk fallback when the Housekeeping System cannot report: DIRTY / CLEANING → AVAILABLE (or RESERVED). Open housekeeping tasks become SUPERSEDED and `RoomCleaned` is published |

Room `status` follows the lifecycle `AVAILABLE`, `RESERVED`, `OCCUPIED`, `DIRTY`, `CLEANING`, `MAINTENANCE` (rules in [ARCHITECTURE.md §7](ARCHITECTURE.md#7-inter-system-integration)). Invalid changes return 409 `INVALID_ROOM_STATUS_TRANSITION`. `displayStatus` is the status, or `INACTIVE` (`isActive: false`) / `DELETED` (archived). `needsCleaning` is true while DIRTY or CLEANING. `?needsCleaning=true` lists those rooms.

### Admin Console (10.0)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/admin/rooms` | A | `{ roomNumber, roomType, capacity, nightlyRate, floor?, description?, amenities? (array or comma list), status?: AVAILABLE\|MAINTENANCE }` |
| PATCH | `/admin/rooms/{id}` | A | Any of the above + `isActive`; `status` may be `AVAILABLE` ("ready": from MAINTENANCE), `DIRTY` (from MAINTENANCE) or `MAINTENANCE` (from any status except OCCUPIED). Marking a DIRTY / CLEANING room AVAILABLE is refused (409 `ROOM_NEEDS_CLEANING`). Room numbers are unique (case-insensitive). OCCUPIED rooms cannot change status or be deactivated; maintenance is refused while a guest is due tonight; deactivating / retyping is refused while bookings (assigned or by type) still need the room |
| DELETE | `/admin/rooms/{id}` | A | Refused if occupied or holding active reservations. Never booked → `{ mode: "deleted" }` (permanent). Has history → `{ mode: "archived" }` (soft delete, history intact) |
| POST | `/admin/rooms/{id}/restore` | A | Bring an archived room back into service |
| GET | `/admin/staff?search=&role=&isActive=` | A | Staff accounts |
| POST | `/admin/staff` | A | `{ fullName, username, password, role: RECEPTIONIST\|ADMINISTRATOR }`. The password is temporary: the user must change it at first sign-in |
| PATCH | `/admin/staff/{id}` | A | Update name, username, role, `isActive` (deactivating signs the user out). The last active administrator can't be removed |
| POST | `/admin/staff/{id}/reset-password` | A | `{ temporaryPassword? }`. Without a body a strong password is generated and returned **once**. Signs the user out everywhere and forces a password change at next sign-in. Not allowed on your own account (use `PUT /me/password`) |

**Password policy** (all endpoints that set a password): 10–72 characters with upper- and lowercase letters, a number and a symbol; must not contain the username or be a common password. Passwords are bcrypt-hashed (cost 12) and never returned. A user with a pending forced change gets `403 PASSWORD_CHANGE_REQUIRED` from every endpoint except `/me` and `/me/password`.
| GET | `/admin/integrations` | A | Integration configuration status, outbox events, inbound request log |
| POST | `/admin/integrations/outbox/{id}/retry` | A | Re-queue a failed webhook |
| GET | `/admin/staybook/room-mappings` | A | Every room with its StayBook room id (or `null`), plus mappings to deleted rooms |
| PUT | `/admin/staybook/room-mappings/{staybookRoomId}` | A | Map a StayBook room to a Frontdesk room: `{ "roomId": 3, "replace": false }`. 409 `ROOM_ALREADY_MAPPED` if the room has another StayBook id (send `replace: true` to swap) |
| DELETE | `/admin/staybook/room-mappings/{staybookRoomId}` | A | Remove a mapping (existing reservations are kept) |
