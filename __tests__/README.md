# Test suite

```bash
npm test            # all suites (xian test)
npm run test:watch
npm run test:coverage
```

Tests run against a separate MySQL database, **`FrontDesk_test`** (override with `TEST_DB_NAME`). It is dropped and recreated at the start of each suite, so your development data is never touched. MySQL must be running. The connection uses `DB_HOST` / `DB_USER` / `DB_PASSWORD` from the environment (defaults: localhost, root, empty password). The developer's `.env` file is deliberately ignored (see `helpers/env.js`).

| Suite | Covers |
|---|---|
| `frontdesk.workflow.test.js` | Figure 17 test cases TC-1 … TC-7 (sequence steps 1–36): reservation, identity retry, check-in, room status, bill + adjustment, declined payment + retry, receipt, checkout, housekeeping, dashboard/report, overbooking under concurrency |
| `integrations.security.test.js` | Per-system API keys (401), scopes (403 when a key is used on another system's endpoint), idempotency (required, replay, key reuse), malformed JSON, HMAC request signatures (missing, wrong secret, tampered body, expired timestamp = replay), HTTPS enforcement, audit log |
| `integrations.booking-pos.test.js` | **Member 1** booking: room type ids, availability, successful reservation with automatic room assignment (RESERVED), guest de-duplication, invalid payloads, no availability, duplicates, concurrent bookings for the last rooms, concurrent duplicates, updates, cancellation (room released, no echo), signed `ReservationUpdated`. **Member 4** POS: charges refused before check-in, `GuestCheckedIn` webhooks, in-house lookup, successful charge in the folio, duplicate prevention (replay, new key), invalid charges (room / guest mismatch, unknown reservation, currency, item totals, amount, future date), folio closed after bill confirmation, refused after checkout, `GuestCheckedOut` |
| `integrations.workflow.test.js` | End to end across all five systems: booking → check-in → POS charges → guest folio and final bill arithmetic (accrued vs billed, adjustments, declined vs successful payments, balance) → checkout (room DIRTY) → signed `RoomVacated` / `GuestCheckedOut` → housekeeping task, started (CLEANING), completed (AVAILABLE) → `RoomCleaned` → duplicate completion → status history → HR verification of a job log. Room status state machine (allowed table, invalid transitions, check-in into DIRTY / CLEANING rooms, admin rules, maintenance). Housekeeping edge cases. Event log, failed webhook retries with backoff → FAILED → admin re-send, duplicate delivery with the same `event_id` |
| `security.test.js` | Session auth, generic login errors, setup/registration lock, CSRF, role-based access, admin room/staff rules |
| `utils.test.js` | Validator, money arithmetic, dates, ID name matching, webhook signature |
| `features.test.js` | Password change / admin reset / session sign-out / forced change; editable assigned room (date-aware eligibility, release of previous room, maintenance, occupied rooms, concurrent assignment, in-house room move); room add / edit / delete / archive / restore and status rules |
| `schema.test.js` | `npm run migrate` upgrade of an old-shaped database (idempotent): new columns, VACANT / needs-cleaning rooms mapped to DIRTY / RESERVED / AVAILABLE, room_types backfill + foreign key, integration enums → VARCHAR; password policy, temporary password generator |
| `shortcuts.test.js` | Ctrl/Cmd + A shortcut logic: platform modifiers, editable targets, open modals, auto-repeat, duplicate listeners, cleanup |

`helpers/harness.js` starts the real Express app on a random port and talks to it over HTTP. There are no mocks of the PMS itself. The other members' systems are simulated: `IntegrationClient` plays each system calling the PMS (API key, Idempotency-Key, HMAC signing), and `startReceiver()` runs a local webhook endpoint per system (ports 39123–39125) that records deliveries, checks their signatures and can simulate an outage. None of the other applications needs to be running.
