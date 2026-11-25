# Make.com build guide

This guide builds the six Make scenarios step by step. The logic is the same as the tested code in `src/`: when you are unsure what a step should do, the matching function is named in each step.

> **Before you start:** Make renames menus and settings from time to time. Each step says what it is **for** as well as which setting to change. If a label in your account is different, follow the intent. After you build each scenario, run its tests in [`tests/TEST_PLAN.md`](../tests/TEST_PLAN.md) and take the screenshots listed there.

## Contents
- [0. Shared set-up](#0-shared-set-up)
- [S0 Gmail → intake webhook](#s0--gmail--intake-webhook)
- [S1 Intake & AI triage](#s1--intake--ai-triage-main-flow)
- [S2 Renewal check](#s2--renewal-check-daily-0700)
- [S3 Health report](#s3--health-report-daily-0800)
- [S4 Watchdog](#s4--watchdog-hourly)
- [S5 Replay dead letters](#s5--replay-dead-letters-manual)
- [Parity table: code ↔ Make](#parity-table-code--make)
- [Exporting blueprints](#exporting-blueprints)

---

## 0. Shared set-up

1. **Google Sheet** "IT Ops Automation — DEMO". Create one tab for each CSV in `sheets/` (Subscriptions, Incidents, ReviewQueue, DeadLetter, RunLog, Config). Then **File → Import → Upload** each CSV into its tab with **Replace current sheet**, so the header row matches exactly. Add the **Health** tab from [`sheets/HEALTH_TAB.md`](../sheets/HEALTH_TAB.md).
2. **Make connections** (Make → Connections): Google Sheets, Gmail, Todoist, and the Anthropic key in a **keychain** (HTTP → "Make an API Key Auth request" → Add keychain → header name `x-api-key`).
3. **Slack**: create an Incoming Webhook for `#it-alerts` (or a Telegram bot). Store the URL in Make as a scenario variable or in the Config tab. **Never in the repo.**
4. **Data store** `it_ops_state` (Make → Data stores → Add). Data structure:

   | Field | Type | Used for |
   |---|---|---|
   | `message_id` | Text | trace |
   | `status` | Text | `processing` / `done` |
   | `sheet_done` | Boolean | replay safety (skip finished actions) |
   | `task_done` | Boolean | replay safety |
   | `alert_done` | Boolean | replay safety |
   | `updated` | Date | trace |

   Keys: `md5(messageId)` for emails. Two special keys hold the watchdog times: `canary_sent` and `canary_seen` (store the time in `updated`).
5. **Data structures** (Make → Data structures → Add → **Generator**, paste the sample):
   - `it-intake-input` ← `make/data-structures/webhook-input.sample.json`
   - `claude-user-message` ← `make/data-structures/user-message.sample.json`
   - `triage-output` ← `make/data-structures/triage-output.sample.json`, **then** set `vendor, service, amount, currency, renewal_date, due_date, ticket_number, incident_start, review_reason` to *not required*. Keep `amount` and `confidence` as **Number** and `needs_human_review` as **Boolean**.
   - `webhook-response` ← `make/data-structures/webhook-response.sample.json`
6. **Scenario settings** for S1 (⋯ → Scenario settings): **Allow storing of incomplete executions = ON** (needed for Break retries), **Sequential processing = ON** (one email at a time, so duplicate checks cannot race), **Number of consecutive errors = 3**.

---

## S0 · Gmail → intake webhook

**Why:** Gmail, the watchdog canary, the acceptance tests and S5 replays all enter S1 the same way, so there is one path to test.

| # | Module | Settings |
|---|---|---|
| 1 | **Gmail → Watch emails** | Folder/label `IT-Intake`, criteria *All email*, max results 10. Schedule: every 15 minutes. |
| 2 | **HTTP → Make a request** | URL: S1 webhook address. Method POST. Body type **Raw**, content type JSON. Request content: map the fields of `it-intake-input` through a **JSON → Create JSON** module first (messageId = Gmail *Message ID*, from, to, date, subject, body = *Text content*; canary = `{{contains(1.subject; "[CANARY]")}}`). |
| ↳ | Error handler on 2 | **Break**: 3 attempts, 1-minute interval. |

---

## S1 · Intake & AI triage (main flow)

Code reference: `src/pipeline.js → processItem()`.

```
Webhook ─► Router ─┬─ canary ─► store canary_seen ─► RunLog ─► Webhook response {heartbeat}
                   └─ email ──► Get record ─► Router ─┬─ duplicate ─► RunLog ─► response {duplicate}
                                                       └─ new ─► Set vars ─► Create JSON ─► HTTP (Claude)
                                                                   ─► Parse JSON ─► Set review_reasons ─► Router (7 routes)
```

### 1 · Webhooks → Custom webhook
Name `it-ops-intake`, data structure `it-intake-input`. Copy the address into S0 and into your local `.env` as `MAKE_WEBHOOK_URL`.

### 2 · Router: canary or email
- Route **Canary**: filter `canary` = true (Boolean) → **Data store → Add/replace a record** key `canary_seen`, `updated` = `{{now}}` → **Google Sheets → Add a row** RunLog (outcome `heartbeat`) → **Webhook response** status 200, body `{"outcome":"heartbeat"}`.
- Route **Email**: fallback route (Make: route ⋯ → *Set as fallback route*).

### 3 · Data store → Get a record
Key `{{md5(1.messageId)}}`. *(code: `store.isProcessed`)*

### 4 · Router: duplicate or new
- Route **Duplicate**: filter `{{3.status}}` equals `done` → RunLog row (outcome `duplicate`) → Webhook response `{"outcome":"duplicate"}`.
- Route **New**: fallback.

### 5 · Tools → Set multiple variables
| Variable | Value |
|---|---|
| `email_text` | `<email>{{newline}}From: {{1.from}}{{newline}}To: {{1.to}}{{newline}}Date: {{1.date}}{{newline}}Subject: {{1.subject}}{{newline}}{{newline}}{{substring(1.body; 0; 8000)}}{{newline}}</email>` |
| `sender_domain` | `{{lower(last(split(replace(1.from; ">"; emptystring); "@")))}}` |
| `numbers_text` | `email_text` with thousands separators removed and Arabic-Indic digits converted (see *Amount check* below) |

*(code: `src/clean.js → buildEmailBlock`. The code also strips quoted replies and signatures; in Make, S0 sends Gmail's plain-text body. See the parity table.)*

### 6 · JSON → Create JSON
Data structure `claude-user-message`: role = `user`, content = `email_text`. This escapes quotes and new lines safely.

### 7 · HTTP → Make an API Key Auth request (Claude)
| Setting | Value |
|---|---|
| Credentials | keychain with header `x-api-key` |
| URL | `https://api.anthropic.com/v1/messages` |
| Method | POST |
| Headers | the other three from `make/http/anthropic-headers.json` (`anthropic-version`, `anthropic-beta`, `content-type`) |
| Body type | Raw · JSON (application/json) |
| Request content | paste **`make/http/anthropic-request.json`** and replace `{{CREATE_JSON.json}}` with the **JSON string** output of module 6 |
| Parse response | Yes |
| Timeout | 120 s |

`tests/clean-and-claude.test.js` proves this template, once filled in, is exactly the request the tested code sends. If you change the prompt or schema, run `npm run export:make` and paste the file again.

**Error handler on module 7** (right-click → Add error handler) → **Router**:
- Route **Temporary**, filter (OR): `{{error.type}}` equals `RateLimitError` / `ConnectionError` / `ModuleTimeoutError`, **or** `{{error.message}}` matches pattern `\b(429|500|502|503|504|529)\b` → **Break**: number of attempts **3**, interval **1** minute. *(code: `src/retry.js`, `temporaryStatuses`)*
- Route **Permanent** (fallback) → the [Dead-letter block](#dead-letter-block) with stage `claude` → **Ignore**.

If Break uses up its retries, the run stays under **Incomplete executions** and Make emails the account owner. S3 also counts incomplete executions (see S3).

### 8 · Check the reply, then JSON → Parse JSON
- Filter before Parse JSON: `{{7.data.stop_reason}}` equals `end_turn`. Otherwise go to a **Review** branch with reason `ai_output {{7.data.stop_reason}}` (refusal / max_tokens). Use a Router with a fallback route.
- Parse JSON: data structure `triage-output`, JSON string `{{first(map(7.data.content; "text"; "type"; "text"))}}`. The reply can contain empty `thinking` blocks before the text block, so pick the block whose `type` is `text`, not `content[1]`.
- **Error handler on Parse JSON** → Review block with reason `ai_output invalid_json` → Ignore. *(code: one extra AI attempt first; see the parity table)*

### 9 · Tools → Set variable `review_reasons`
One `if()` per rule, joined together. Code reference: `src/validate.js → validateResult()`. `P` = Parse JSON module number.

```text
{{if(P.confidence < 0.75; "low confidence | "; emptystring)}}
{{if(P.needs_human_review; "AI asked for review: " + P.review_reason + " | "; emptystring)}}
{{if(P.category = "subscription_renewal" and (ifempty(P.vendor; emptystring) = emptystring or ifempty(P.service; emptystring) = emptystring or ifempty(P.renewal_date; emptystring) = emptystring); "missing renewal fields | "; emptystring)}}
{{if(P.category = "vendor_invoice" and (ifempty(P.vendor; emptystring) = emptystring or ifempty(P.amount; emptystring) = emptystring or ifempty(P.currency; emptystring) = emptystring or ifempty(P.due_date; emptystring) = emptystring); "missing invoice fields | "; emptystring)}}
{{if(P.category = "outage_notice" and (ifempty(P.vendor; emptystring) = emptystring or ifempty(P.service; emptystring) = emptystring); "missing outage fields | "; emptystring)}}
{{if((P.category = "security_alert" or P.category = "access_request") and ifempty(P.service; emptystring) = emptystring; "missing service | "; emptystring)}}
{{if(ifempty(P.amount; emptystring) != emptystring and not(contains(numbers_text; formatNumber(P.amount; 2; "."; emptystring))) and not(contains(numbers_text; " " + P.amount + " ")); "amount not found in the email text | "; emptystring)}}
{{if((P.category = "subscription_renewal" or P.category = "vendor_invoice") and not(contains(TRUSTED_DOMAINS; "," + sender_domain + ",")); "untrusted sender domain | "; emptystring)}}
```
Write these as one value on one line. If your Make account does not take `and` / `or` / `not()` inside `if()`, split the rule into two nested `if()` calls (or swap the then/else branches in place of `not()`). Test this variable with F16–F20 before you build the routes. `TRUSTED_DOMAINS` is the `trusted_domains` value from the Config tab with a comma added at each end (`,contoso-cloud.example,vaultpass.example,…,`), so a partial domain cannot match.

**Amount check (`numbers_text`):** `{{replace(replace(email_text; ","; emptystring); "٫"; ".")}}`. For Arabic-Indic digits, add ten nested `replace()` calls (`"٠"`→`"0"` … `"٩"`→`"9"`). *(code: `normaliseNumbers`)*

### 10 · Router: seven routes
Every route except Review has two conditions: `review_reasons` **is empty** AND `category` equals the value shown. Review is the fallback route.

| Route | Filter | Modules (in order) | Code |
|---|---|---|---|
| **Renewal** | `subscription_renewal` | Sheets **Add a row** Subscriptions (kind `renewal`, status `active`) → Data store update `sheet_done=true` → **Todoist → Create a task** (due = `{{formatDate(addDays(P.renewal_date; -14); "YYYY-MM-DD")}}`, but not before today) → `task_done=true` | `planActions` |
| **Invoice** | `vendor_invoice` | Subscriptions row (kind `invoice`, status `invoice_received`) → Todoist task due 3 days before `due_date` | ″ |
| **Outage** | `outage_notice` | Incidents row → **HTTP POST Slack webhook** (`[URGENT]` if urgency is `critical`, else `[NOTICE]`) → Todoist task (p1/p2) | ″ |
| **Security** | `security_alert` | Incidents row (kind `security`) → Slack `[URGENT]` → Todoist **p1** | ″ |
| **Access** | `access_request` | Todoist task → **Gmail → Create a draft** reply (never *Send*) | ″ |
| **Log only** | `other` | nothing | ″ |
| **Review** (fallback) | — | ReviewQueue row (reasons = `review_reasons`) → Todoist "Review AI triage: {{1.subject}}" p2 | `planReview` |

**Before each action**, add a filter `<flag>_done` is not equal to true (from module 3). This way an S5 replay skips the steps that already finished. *(code: `store.isActionDone`)*

**Error handler on every Sheets / Todoist / Slack module:** the same Router as module 7 (Temporary → Break 3×; Permanent → Dead-letter block with stage `action:sheet` / `action:todoist` / `action:alert` → Ignore).

**End of every route:**
- **Data store → Add/replace a record** key `md5(messageId)`, status `done`
- **Google Sheets → Add a row** RunLog: time, message_id, subject, category, confidence, route, outcome (`routed` or `review`), detail = `review_reasons`
- **Webhook response**: status 200, body `{"outcome":"routed","route":"renewal","category":"{{P.category}}","confidence":{{P.confidence}},"reasons":"{{review_reasons}}"}`. `tools/run-acceptance.js` reads this.

### Dead-letter block
Used by every **Permanent** error route. *(code: `pipeline.fail()`)*
1. **Google Sheets → Add a row** DeadLetter: id `DL-{{formatDate(now; "YYYYMMDDHHmmss")}}`, time, scenario `S1 Intake`, stage, error_status `{{error.type}}`, error_message `{{error.message}}`, classification `permanent`, attempts, message_id, subject, status `open`, payload_json = the webhook body (`{{toString(1)}}` or rebuild it with a Create JSON module).
2. **HTTP → POST Slack webhook** with the alert text from `formatFailureAlert` (stage, error, item, DeadLetter id, next step).
   - Error handler on this module → **Gmail → Send an email** to the IT mailbox with the same text → **Ignore**. A failure is never silent, even when Slack is down.
3. **Webhook response** `{"outcome":"dead_letter","stage":"…"}`.

---

## S2 · Renewal check (daily 07:00)

Code reference: `src/scheduled.js → dueRenewals()`, `src/alerts.js → formatRenewalDigest()`.

| # | Module | Settings |
|---|---|---|
| 1 | **Google Sheets → Search rows** | Subscriptions, filter kind = `renewal` AND status = `active` |
| 2 | Filter | `{{formatDate(1.renewal_date; "YYYY-MM-DD")}}` equals `{{formatDate(addDays(now; 30); "YYYY-MM-DD")}}` **OR** the same with 7 **OR** 1 **OR** renewal date is before today (overdue) |
| 3 | **Todoist → Create a task** | "Renewal in N days: vendor service", due today, p2 |
| 4 | **Tools → Text aggregator** | one line per row: `• vendor · service renews date` |
| 5 | **HTTP → POST Slack** | `[NOTICE] Renewal check {{today}}: …` (send nothing if the aggregator is empty, or send `[OK] nothing renews`) |

Matching the exact day (30, 7 or 1 days away) means each warning is sent once, not every day.

---

## S3 · Health report (daily 08:00)

Code reference: `src/scheduled.js → computeHealth()`.

| # | Module | Settings |
|---|---|---|
| 1 | **Google Sheets → Get range values** | `Health!A2:H2` (the tab computes the counts with formulas: see `sheets/HEALTH_TAB.md`) |
| 2 | *(optional)* **Make → Make an API call** | `GET /api/v2/dlqs?scenarioId=<S1 id>` → number of incomplete executions (Break retries used up). Check the endpoint in the Make API reference for your zone. |
| 3 | **Tools → Set variable** `status` | `{{if(open_dead_letters > 0 or watchdog_fired or hours_since_run > 24 or incomplete > 0; "ALERT"; if(open_review >= 5 or retries_24h > 0; "WARNING"; "OK"))}}` |
| 4 | **HTTP → POST** | Slack (and the optional status webhook), text from `formatHealthReport` |

---

## S4 · Watchdog (hourly)

Code reference: `src/scheduled.js → checkWatchdog()`.

| # | Module | Settings |
|---|---|---|
| 1 | **Data store → Get a record** `canary_sent` | |
| 2 | **Data store → Get a record** `canary_seen` | |
| 3 | Filter → **Slack `[ALERT]`** | sent exists AND (seen is empty OR seen < sent) AND sent is older than 20 minutes: "Watchdog: the canary sent at … was not processed. S0/S1 may be off, out of operations, or Gmail is not delivering." |
| 4 | **Gmail → Send an email** | to the intake mailbox, subject `[CANARY] watchdog {{formatDate(now; "YYYY-MM-DDTHH:mm")}}`, so the canary goes through Gmail → S0 → S1, end to end. Add a Gmail filter that labels `[CANARY]` mail `IT-Intake`. |
| 5 | **Data store → Add/replace** `canary_sent` | updated = now |

---

## S5 · Replay dead letters (manual)

Code reference: `pipeline.replay()`.

| # | Module | Settings |
|---|---|---|
| 1 | **Webhooks → Custom webhook** `it-ops-replay` | input: `{ "deadLetterId": "DL-…" }` |
| 2 | **Google Sheets → Search rows** | DeadLetter where id = input and status = `open` |
| 3 | **HTTP → POST** | S1 webhook, body = `payload_json` |
| 4 | Filter: response outcome is `routed` / `review` / `duplicate` → **Google Sheets → Update a row** | status `replayed`, replayed_at now |

Use it only **after** fixing the root cause (wrong key, deleted project…). The `_done` flags in the data store stop the steps that already worked from running twice.

---

## Parity table: code ↔ Make

| Rule | Code (`src/`) | Make | Same? |
|---|---|---|---|
| Duplicate check | `store.isProcessed` | Data store get + filter | ✅ |
| Request body | `buildRequest` | `anthropic-request.json` (tested equal) | ✅ |
| Retry temporary errors, not permanent ones | `withRetry` 15 s / 60 s / 300 s | Break 3 × 1 min | ⚠️ different intervals; Make's shortest Break interval is 1 minute |
| Unreadable AI output | 1 extra AI attempt, then review | straight to review | ⚠️ rare with structured outputs |
| Refusal / max_tokens | review | filter on `stop_reason` → review | ✅ |
| Schema check | `checkSchema` | Parse JSON with data structure + required filters | ✅ (Make checks types, not date formats) |
| Confidence / AI review / required fields | `validateResult` | `review_reasons` formula | ✅ |
| Amount must appear in email | `amountAppearsInText` | `contains(numbers_text; …)` | ✅ (Make version is a plain text match) |
| Date range sanity check | `validateResult` (−60…+800 days) | not built | ⚠️ add a filter if needed |
| Trusted sender domains | `senderDomain` + config | `TRUSTED_DOMAINS` formula | ✅ |
| Quoted-reply/signature stripping | `cleanBody` | not built (Gmail text body) | ⚠️ longer prompts, same result |
| Replay without duplicates | `doneActions` | `_done` flags in the data store | ✅ |
| Alert fallback to email | `sendFailureAlert` | Slack error handler → Gmail | ✅ |

---

## Exporting blueprints

After each scenario works and its tests pass:
1. Scenario ⋯ → **Export blueprint**. Save as `make/blueprints/S1-intake.blueprint.json` (S0…S5).
2. Run `npm run check:secrets`. It flags connection IDs (`__IMTCONN__`), webhook URLs and keys. Replace connection IDs with `null` and webhook URLs with `REDACTED`.
3. Commit with the version in the message (`S1 v1.0.0`). Rollback = import the previous blueprint ([docs/CHANGE_CONTROL.md](../docs/CHANGE_CONTROL.md)).
