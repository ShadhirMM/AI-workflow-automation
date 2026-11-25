# AI build log

How AI tools were used to build this project, and how each output was checked. The rule throughout: **AI writes, tests decide.**

Tools: Claude Code (model Claude Opus 5.5) for design, code, tests and docs; Claude via the API as the triage model inside the automation.

## Build steps

| # | Step | What the AI produced | How it was checked |
|---|---|---|---|
| 1 | Plan | `IMPLEMENTATION_PLAN.md`: use case, scenarios, failure table, phases, all mapped to the job description | Read against the job description line by line (table in §1 of the plan) |
| 2 | Prompt + schema first | `prompts/triage.md`, `prompts/triage.schema.json` | A unit test checks the schema follows the structured-output limits (closed objects, no min/max/length constraints) and that every property is required. The live check is `npm run eval` |
| 3 | Test data before code | 31 fixtures covering normal mail, edge cases (Arabic, forwarded, phishing, injection, missing data, wrong AI answer) and failures (429, 529, 401, bad JSON, refusal, Todoist 404, duplicate, canary) | Each fixture has an explicit `expected` outcome written before the pipeline existed |
| 4 | Reference implementation | `src/` modules, one per step of the Make scenario | 41 unit tests; full simulation 31/31 |
| 5 | Make request template | Generated from the same code by `npm run export:make`, not written by hand | A test fills the template the way Make's Create JSON does (with quotes, new lines and Unicode) and asserts it equals the tested request byte for byte. A second test fails if the generated files are stale |
| 6 | Make build guide | Module-by-module steps, formulas, error handlers, plus a parity table listing where Make differs from the code | Every step names the code function it mirrors. Differences are listed openly, not hidden |
| 7 | Secrets scanner | `tools/check-secrets.js` | Unit test with planted fake secrets (built at runtime, so the repo itself stays clean) |

## Checks on the AI's own work

- **Mutation check:** the amount check (`amountAppearsInText`) was switched off on purpose. 2 tests failed (the F20 simulation and the amount unit test), and both passed again once it was restored. This shows the tests detect a real regression, not just that they run.
- **First simulation run found no failures:** to make sure the tests were not passing by accident, the counts were checked by hand: 37 mock Claude calls = 22 single calls + F24 (3) + F25 (4) + F26 (1) + F27 (2) + F28 (2) + F29 (1) + F30 (1) + replay (1).
- **Edge cases designed in, each with a test:**
  - A forwarded email's real content sits *below* the forwarder's signature, so signature stripping must not cut it off (F21 + unit test).
  - The amount `29.95` must not match inside `299.95`. The regex uses number boundaries (unit test).
  - Opus 5.5 replies can start with empty `thinking` blocks, so both the code and the Make mapping pick the block with `type = text` instead of `content[1]` (unit test).
  - A replay after a partial failure (sheet written, Todoist failed) must not write the sheet row twice, so each finished action is recorded (F30 + unit test).
- **Found and fixed during the build:** `node --test tests/` does not accept a folder on Node 22. The test script uses a file glob instead, so CI runs every test file.
- **API details** (model ID, `anthropic-version`, structured outputs `output_config.format`, refusal fallbacks) were taken from Anthropic's current API reference material, not from memory.

## Not yet verified (needs accounts)

| Item | Why open | How it will be verified |
|---|---|---|
| Live prompt accuracy | No API key on the build machine | `npm run eval` → `tests/results/eval-<date>.md` |
| Make scenarios | Need a Make account; UI labels can differ from the guide | Build per BUILD_GUIDE, then `npm run acceptance` + T01–T18 with screenshots |
| Rollback | Needs two exported blueprint versions | T17, recorded in CHANGE_CONTROL.md |

These are listed here so a reviewer can see exactly what has been proven and what has not.
