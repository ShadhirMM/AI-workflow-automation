# Operations runbook

## Daily (5 minutes)

1. Read the **08:00 health report** in `#it-alerts`.
   - **OK**: nothing to do.
   - **WARNING**: work through the review queue, or check why retries were needed (provider status page).
   - **ALERT**: follow *Responding to an alert* below.
2. Work through the **ReviewQueue** tab. For each `open` row:
   - Read the email (the `source` column links to it).
   - Do the right thing by hand: add the subscription row, create the task, or delete it as spam/phishing.
   - Set `status` = `closed`, and fill `reviewer` and `decision` (`correct-ai`, `wrong-ai`, `phishing`, `no-action`).
   - Mark `wrong-ai` honestly. Those rows are the input for the next prompt change.
3. Check the **07:00 renewal digest**. Every listed renewal should have a task with an owner.

## Responding to an alert

| Alert says | Likely cause | Fix | Then |
|---|---|---|---|
| `401` / "Check the API key" | Key revoked or expired | Make → Keys → update the keychain | S5 replay each open dead letter |
| `403` | Connection lost permission (Google, Todoist) | Re-authorise the connection | S5 replay |
| `404` / "configured ID" | Sheet, tab or Todoist project renamed or deleted | Restore the name or remap the module | S5 replay |
| `429` / retries exhausted | Rate limit or plan quota | Check the Anthropic Console usage; raise limits or slow S0 to every 30 min | Complete the run under *Incomplete executions* |
| `529` / `5xx` | Provider outage | Check the provider status page; wait | Complete the incomplete execution or S5 replay |
| `Watchdog: canary not processed` | S0/S1 switched off, Make operations used up, Gmail filter broken | Scenario list → check both are ON; Org → operations usage; Gmail filter | Wait for the next S4 run (should be quiet) |
| `no run for 24h+` | No mail arrived **or** S0 broken | Send a test email to the intake mailbox | — |

**Replay (S5):** send `{"deadLetterId":"DL-…"}` to the `it-ops-replay` webhook (Postman, curl or a bookmark), **only after fixing the cause**. Steps that already worked are skipped, so a replay never creates duplicate rows or tasks.

**Root cause, not just retry:** after every ALERT, add a row to the **Incidents** tab with kind `automation`: date, cause (in `summary`), the fix, and how to stop it happening again. Repeated causes become changes (see CHANGE_CONTROL.md).

## Weekly
- Look at a sample of 5 routed items. Was the category right? Were the amount and date right?
- Clear `closed` ReviewQueue rows older than 30 days (export them first).
- Check Make operations and Anthropic spend against budget.

## Monthly
- Run `npm run eval` against the fixtures and add any new real-world edge case as a fixture (with invented details).
- Review the trusted domain list (`config/config.json` + Config tab) against the vendors you actually use.
- Rotate the API key if your policy asks for it.

## Switching it off safely
1. Turn off S0 first (stops new mail), then S4 (otherwise the watchdog fires).
2. Wait for S1 to finish its queue, then turn it off.
3. Mail keeps arriving under the IT-Intake label. When S0 is turned back on, it processes everything it missed, and duplicates are skipped.
