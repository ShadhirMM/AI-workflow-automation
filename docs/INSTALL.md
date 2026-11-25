# Installation

About half a day the first time. Use a **separate demo Google account** and demo data only.

## What you need

| Item | Plan | Notes |
|---|---|---|
| Make.com account | Free plan is enough for the demo (check the current operation limits) | Needs *incomplete executions* for Break retries |
| Google account (demo) | Free | Gmail, Google Sheets |
| Todoist | Free | Project "IT Ops (Demo)" |
| Slack workspace or Telegram bot | Free | For alerts (incoming webhook) |
| Anthropic API key | Pay as you go | **Set a monthly spend limit** in the Console |
| Node.js 20+ | — | Only for tests, simulation and evaluation on your PC |

## 1. Get the code and run the offline checks

```bash
git clone https://github.com/ShadhirMM/AI-workflow-automation.git
cd AI-workflow-automation
npm install
npm test            # 41 tests
npm run simulate    # 31 test emails through the full flow, offline
```
Both must pass before you touch Make.

## 2. Check the prompt against the real model

```bash
cp .env.example .env          # put your key in .env, never commit it
# PowerShell:  $env:ANTHROPIC_API_KEY = "…"     Git Bash:  export ANTHROPIC_API_KEY=…
npm run eval
```
Open `tests/results/eval-<date>.md`. **Confident but wrong must be 0.** Cost: a few cents.

## 3. Google side
1. In Gmail, create the label **IT-Intake**, plus a filter that applies it to IT admin mail (for the demo: mail to `you+it@gmail.com`).
2. Create the Sheet "IT Ops Automation — DEMO". Import each CSV from `sheets/` into its own tab. Add the Health tab from `sheets/HEALTH_TAB.md`.
3. Share the Sheet with **nobody**.

## 4. Todoist and Slack
1. In Todoist, create the project **IT Ops (Demo)**.
2. In Slack, create an app → Incoming Webhooks → add it to `#it-alerts` → copy the URL. Keep it in Make only.

## 5. Build the scenarios in Make
Follow [`make/BUILD_GUIDE.md`](../make/BUILD_GUIDE.md) in order: shared set-up → S1 → S0 → S2 → S3 → S4 → S5. Build S1 first and test it with the webhook before connecting Gmail.

## 6. Turn the scenarios on
| Scenario | Schedule |
|---|---|
| S0 Gmail → webhook | every 15 min |
| S1 Intake | instant (webhook) |
| S2 Renewal check | daily 07:00 |
| S3 Health report | daily 08:00 |
| S4 Watchdog | hourly |
| S5 Replay | on demand (webhook) |

## 7. Run the acceptance tests
```bash
# PowerShell: $env:MAKE_WEBHOOK_URL = "https://hook.eu2.make.com/…"
npm run acceptance
```
Then run the manual tests T01–T18 in [`tests/TEST_PLAN.md`](../tests/TEST_PLAN.md) and save the screenshots in `docs/screenshots/`.

## 8. Export and commit the blueprints
See *Exporting blueprints* in the build guide. Always run `npm run check:secrets` before `git commit`.
