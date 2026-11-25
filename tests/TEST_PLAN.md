# Test plan

Three layers of tests. Each one keeps evidence in `tests/results/`.

| Layer | Command | Needs | What it proves |
|---|---|---|---|
| 1. Unit + simulation | `npm test`, `npm run simulate` | nothing (runs in CI) | Every rule: checks, routing, retries, dead letters, replay, health, watchdog, and that the Make request template equals the tested request |
| 2. Prompt evaluation | `npm run eval` | `ANTHROPIC_API_KEY` | The real model classifies and extracts correctly. **Confident-but-wrong must be 0** |
| 3. Make acceptance | `npm run acceptance` + manual tests below | Make scenarios built, `MAKE_WEBHOOK_URL` | The live scenarios route each email correctly and handle failures |

Go-live rule: layers 1 and 2 pass, every manual test below passes with a screenshot, and the rollback (T17) has been practised.

---

## Layer 1: automated (offline)

41 tests in `tests/*.test.js`, plus 31 fixtures run end to end by the simulator. Latest results: `tests/results/simulation-report.md` and `tests/results/unit-tests.txt`.

| Fixture | What it covers | Expected |
|---|---|---|
| F01–F03 | Renewals (USD, AED with thousands separator, domain expiry) | Subscriptions row + Todoist task |
| F04–F06 | Invoices (AED, USD, EUR) | Subscriptions row (invoice) + task |
| F07–F09 | Outages (total, degraded, cloud controller) | Incidents row + alert (URGENT only for critical) + task |
| F10–F11 | Security alerts | Incidents row + URGENT alert + p1 task |
| F12–F13 | Access requests | Task + draft reply (not sent) |
| F14–F15 | Newsletter, out-of-office | Logged only |
| F16 | Phishing: new bank details from a look-alike domain | Review (untrusted domain) |
| F17 | Prompt injection inside a real renewal | Review (AI flagged instructions) |
| F18 | Ambiguous request | Review (low confidence) |
| F19 | Renewal with no date | Review (missing field) |
| F20 | AI returns the wrong amount (simulated mistake) | Review (amount not in email) |
| F21 | Renewal forwarded by a colleague | Renewal (internal sender allowed) |
| F22 | Arabic invoice with Arabic-Indic digits | Invoice |
| F23 | Same message delivered twice | Duplicate, no second AI call |
| F24 | 429 twice, then success | Routed after 2 retries |
| F25 | 529 on every attempt | Dead letter after 4 attempts + alert |
| F26 | 401 bad key | Dead letter after 1 attempt (no retries) + alert |
| F27 | Unreadable AI output once | Routed after 1 extra attempt |
| F28 | Unreadable AI output always | Review |
| F29 | Model declines (`refusal`) | Review |
| F30 | Todoist 404 after the sheet row was written | Dead letter; replay creates the task, **no duplicate row** |
| F31 | Watchdog canary | Heartbeat, no AI call |

Mutation check, done once during the build: switching off the amount check made 2 tests fail (the F20 simulation and the amount unit test). The tests catch real regressions.

## Layer 2: prompt evaluation (live Claude)

`npm run eval` sends F01–F22 and F24, F27, F30 (the fixtures with real content) to the API with the production request.

| Metric | Target |
|---|---|
| Category accuracy | ≥ 95% |
| Field accuracy (amount, currency, dates, ticket, vendor) | ≥ 95% |
| Confident but wrong (passed every check but was wrong) | **0** |
| Errors | 0 |

F16 (phishing), F17 (injection) and F18 (ambiguous) are the important ones. They must end in **review**. If one routes, change the prompt, run `npm run eval` again, and record the change in `CHANGELOG.md`.

## Layer 3: Make acceptance (live)

### Automated part
`MAKE_WEBHOOK_URL=… npm run acceptance` posts F01–F22 and F23 (duplicate) to the S1 webhook and checks the JSON returned by the webhook. Message IDs get a run suffix, so the run can be repeated. Report: `tests/results/acceptance-<date>.md`.

### Manual tests (screenshot each into `docs/screenshots/`)

| ID | Test | Steps | Pass when |
|---|---|---|---|
| T01 | Gmail trigger end to end | Send F01's text to the intake mailbox with label IT-Intake | Row in Subscriptions, Todoist task, RunLog `routed` within 15 min |
| T02 | Renewal route | Acceptance F01 | Task due 14 days before renewal |
| T03 | Outage route | Acceptance F07 | `[URGENT]` Slack message, Incidents row, p1/p2 task |
| T04 | Security route | Acceptance F11 | `[URGENT]` Slack, p1 task |
| T05 | Access route | Acceptance F12 | Task + **draft** in Gmail Drafts (nothing sent) |
| T06 | Review queue | Acceptance F16–F19 | Four ReviewQueue rows with readable reasons |
| T07 | Duplicate | Acceptance F23 | `duplicate`, no second Claude call in the Make history |
| T08 | Prompt injection | Acceptance F17 | Review, nothing marked paid, nothing forwarded |
| T09 | Arabic email | Acceptance F22 | Invoice with amount 315 |
| T10 | Temporary error + retry | Point the HTTP module URL at `https://httpstat.us/503` for one run (or use a mock endpoint) | Break retries 3×; run appears under Incomplete executions; Make email received |
| T11 | Permanent error | Put a wrong key in the keychain, send F01 | DeadLetter row `claude`, Slack `[ALERT]` with "Check the API key", no retries |
| T12 | Alert fallback | Same as T11 with the Slack webhook URL broken | Alert arrives by **email** instead |
| T13 | Partial failure + replay | Point Todoist at a deleted project, send F30, fix it, call S5 with the DeadLetter id | One Subscriptions row (not two), one task, DeadLetter `replayed` |
| T14 | Renewal digest | Add a row renewing in exactly 7 days, run S2 | Digest lists it once; running again the next day does not repeat it |
| T15 | Health report | Run S3 with an open dead letter, then after closing it | `[ALERT]` then `[OK]`/`[WARNING]` |
| T16 | Watchdog | Turn S1 **off**, wait for S4 twice | `[ALERT] Watchdog…` within ~80 min; turn S1 on → next run is quiet |
| T17 | Rollback | Change the prompt (v1.1.0), export, then import the v1.0.0 blueprint | Acceptance run passes again on v1.0.0 (see CHANGE_CONTROL.md) |
| T18 | Secrets | `npm run check:secrets` after exporting blueprints | No findings |
