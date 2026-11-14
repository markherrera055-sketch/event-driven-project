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
| `integrations.test.js` | Simulated Hotel Reservation System and POS: API keys, validation, idempotent replay, duplicate protection, availability, sync of changes and cancellations, folio charges, signed webhooks |
| `security.test.js` | Session auth, generic login errors, setup/registration lock, CSRF, role-based access, admin room/staff rules |
| `utils.test.js` | Validator, money arithmetic, dates, ID name matching, webhook signature |
| `features.test.js` | Password change / admin reset / session sign-out / forced change; editable assigned room (date-aware eligibility, release of previous room, maintenance, occupied rooms, concurrent assignment, in-house room move); room add / edit / delete / archive / restore and status rules |
| `schema.test.js` | `npm run migrate` upgrade of an old-shaped database (idempotent), password policy, temporary password generator |
| `shortcuts.test.js` | Ctrl/Cmd + A shortcut logic: platform modifiers, editable targets, open modals, auto-repeat, duplicate listeners, cleanup |

`helpers/harness.js` starts the real Express app on a random port and talks to it over HTTP. There are no mocks.
