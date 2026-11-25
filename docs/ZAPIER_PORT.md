# Zapier port of S1 (and Make vs Zapier)

The job description names both Make and Zapier. This page shows how the same intake flow maps onto Zapier, and when to choose which tool.

## The Zap

| Step | Zapier app / action | Notes |
|---|---|---|
| 1 | **Gmail → New Labeled Email** (`IT-Intake`) | Trigger |
| 2 | **Webhooks by Zapier → Custom Request** POST `https://api.anthropic.com/v1/messages` | Body = `make/http/anthropic-request.json`. Build the `messages` entry with step 3 of a Formatter or with Code by Zapier, so the email text is JSON-escaped. Headers from `anthropic-headers.json`; store the key in the step, not in the Zap name or notes |
| 3 | **Code by Zapier (JavaScript)** | Paste the checks from `src/validate.js` (`normaliseNumbers`, `amountAppearsInText`, `validateResult` without the imports) and return `{decision, reasons, category}`. Same rules, same thresholds |
| 4 | **Paths** | One path per route: renewal / invoice / outage / security / access / review (filters on `decision` and `category`) |
| 5 | Google Sheets / Todoist / Slack / Gmail *Create Draft* | Same rows and tasks as in Make |
| — | Duplicate check | **Storage by Zapier**: get the key `md5(message id)`, then set it at the end |
| — | Errors | Zap settings → **Error notifications** on; **Autoreplay** on (retries failed steps automatically; available on paid plans); optional per-step **error handler** path that writes the DeadLetter row and posts the alert |

## Make vs Zapier for this job

| | Make | Zapier |
|---|---|---|
| Error handling | Error routes on any module: Break (retry), Resume, Ignore, Rollback, Commit; incomplete executions you can complete later | Autoreplay (paid plans), error notifications, per-step error handler paths |
| Logic | Routers, filters, iterators, aggregators, formulas | Paths, Filters, Formatter, Code steps |
| Version control | Blueprint JSON export/import → Git | No full export of a Zap as a file that can be re-imported the same way; changes are tracked in the Zap's version history |
| Running cost | Charged per operation (each module run) | Charged per task (each action step run) |
| Best for | Multi-branch flows with real error handling and change control (this project) | Quick, linear automations that non-technical colleagues can read and edit |

**Choice for this project: Make**, because the blueprint export gives a Git-tracked, testable rollback, and error routes can tell temporary failures from permanent ones. Zapier is a good choice for simple team automations, for example "new form response → Todoist task".
