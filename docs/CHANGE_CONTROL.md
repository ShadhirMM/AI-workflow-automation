# Change control

Every change to a scenario, the prompt, the schema or the config follows the same five steps.

## 1. Scope
Write a short change record (copy the template below into `CHANGELOG.md` under *Unreleased*):
- What changes and why, the ticket or Todoist task, the risk (low/medium/high), the scenarios affected, and the planned date.

## 2. Test before go-live
1. `npm test` and `npm run simulate`: all green.
2. A prompt or schema change also needs `npm run eval`: category ≥ 95%, field ≥ 95%, **confident-but-wrong = 0**. Compare with the previous eval report.
3. `npm run export:make`, then paste the new request body into a **copy** of S1 ("S1 Intake — STAGING", with its own webhook).
4. Run `npm run acceptance` against the staging webhook.

## 3. Deploy
1. Export the current production blueprint first (`S1-intake.blueprint.json`, version N). **This is the rollback.**
2. Apply the change to production S1 in a quiet period (not during an outage).
3. Send one fixture through production, and check the Sheet, the task and RunLog.
4. Export the new blueprint (version N+1), run `npm run check:secrets`, commit, and tag `vX.Y.Z`.

## 4. Roll back
Use this if production behaves badly after a change:
1. Turn S0 **off** (mail waits safely in Gmail).
2. In Make, open S1 → ⋯ → **Import blueprint** → choose the version N file from Git (`git show vN:make/blueprints/S1-intake.blueprint.json > rollback.json`). Make also keeps previous versions under scenario ⋯ → *Previous versions*. That is faster, but Git is the record.
3. Reconnect the connections if asked (blueprints carry no credentials).
4. Run `npm run acceptance`. It must pass.
5. Turn S0 back on. Missed mail is processed, and duplicates are skipped.
6. Record the rollback in `CHANGELOG.md`.

## 5. Document
- Update `CHANGELOG.md`, and `make/BUILD_GUIDE.md` if a step changed.
- Note the eval/acceptance report file names as evidence.

## Rollback test record

| Date | From → to | Steps run | Acceptance after rollback | By |
|---|---|---|---|---|
| _to fill after the live build_ | v1.1.0 → v1.0.0 | 1–6 above | _x/x passed_ | |

## Change record template

```
### [x.y.z] — YYYY-MM-DD
- Change:
- Reason / ticket:
- Risk: low | medium | high
- Scenarios: S1
- Tests: npm test ✅ · simulate 31/31 ✅ · eval (file) · acceptance (file)
- Rollback: blueprint vN tagged in Git
```
