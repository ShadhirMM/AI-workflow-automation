# Changelog

## [1.0.0] — 2026-11-26
- Reference implementation of S1 (intake & AI triage): duplicate check, Claude structured-output call, validation (schema, confidence, required fields, amount-in-text, date range, trusted senders), routing, retries, dead letters with email fallback, replay without duplicates.
- Scheduled logic: S2 renewal digest (30/7/1 days + overdue), S3 OK/WARNING/ALERT health, S4 canary watchdog.
- 31 fixtures, 41 unit tests, offline simulator, live prompt eval, Make acceptance runner, secrets scanner.
- Make build guide with parity table; generated HTTP body/headers, data structures and sheet templates.
- Tests: npm test 41/41 ✅ · simulate 31/31 ✅ · check:secrets ✅
- Not yet run: live eval, Make build, acceptance, rollback test (need accounts; see docs/AI_BUILD_LOG.md).
