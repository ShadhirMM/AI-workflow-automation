# Blueprints

Exported Make scenarios go here, one file per scenario, after each one is built and tested:

```
S0-gmail-to-webhook.blueprint.json
S1-intake.blueprint.json
S2-renewal-check.blueprint.json
S3-health-report.blueprint.json
S4-watchdog.blueprint.json
S5-replay.blueprint.json
```

Before committing an export:
1. Run `npm run check:secrets`. It flags Make connection IDs (`"__IMTCONN__"` followed by a number), data store and hook IDs, webhook URLs and keys.
2. Replace connection IDs with `null` and webhook URLs with `"REDACTED"`. Make asks for connections again on import, so nothing is lost.
3. Commit with the scenario version in the message, and tag releases (`v1.0.0`). Rollback is described in [docs/CHANGE_CONTROL.md](../../docs/CHANGE_CONTROL.md).

These are exported from a working scenario, not written by hand. The scenarios are built with [`../BUILD_GUIDE.md`](../BUILD_GUIDE.md).
