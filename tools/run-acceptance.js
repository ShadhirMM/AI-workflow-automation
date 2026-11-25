#!/usr/bin/env node
// npm run acceptance   (needs MAKE_WEBHOOK_URL: the S1 test webhook)
//
// Posts each fixture to the live Make scenario S1 (webhook trigger) and checks
// the JSON returned by its "Webhook response" module against the expected
// outcome. Message IDs get a run suffix so the run can be repeated; F23 reuses
// F01's suffixed ID to prove duplicates are skipped.
// Fixtures whose failure is only scripted in the mock (F24–F31) are skipped:
// those failure tests are run by hand in Make (tests/TEST_PLAN.md, T10–T16).
// Writes tests/results/acceptance-<date>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { loadFixtures } from '../src/simulation.js';

const url = process.env.MAKE_WEBHOOK_URL;
if (!url) {
  console.error('Set MAKE_WEBHOOK_URL to the S1 test webhook address (see docs/INSTALL.md, step 7).');
  process.exit(2);
}

const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const fixtures = loadFixtures().filter((f) => !f.mock.sequence || f.duplicateOf);
const withId = (id) => id.replace('>', `.run${runId}>`);

const rows = [];
for (const f of fixtures) {
  const email = { ...f.email, messageId: withId(f.email.messageId) };
  const t0 = Date.now();
  let status;
  let body;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(email) });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (err) {
    rows.push({ f, ok: false, detail: `request failed: ${err.message}` });
    continue;
  }
  const exp = f.expected;
  const wantRoute = exp.liveRoute ?? exp.route;
  const problems = [];
  if (status !== 200) problems.push(`HTTP ${status}`);
  const wantOutcome = exp.liveRoute ? 'routed' : exp.outcome;
  if (body.outcome !== wantOutcome) problems.push(`outcome ${body.outcome} ≠ ${wantOutcome}`);
  if (wantRoute && body.route !== wantRoute) problems.push(`route ${body.route} ≠ ${wantRoute}`);
  rows.push({ f, ok: problems.length === 0, detail: problems.join('; '), body, ms: Date.now() - t0 });
  console.log(`${f.id} ${problems.length ? `FAIL ${problems.join('; ')}` : 'ok'} (${Date.now() - t0} ms)`);
}

const passed = rows.filter((r) => r.ok).length;
const date = new Date().toISOString().slice(0, 10);
const md = [`# Make acceptance run — ${date} (run ${runId})`, '', `**${passed}/${rows.length} passed.**`, '',
  '| ID | Scenario | Outcome | Route | Category | Confidence | Result |', '|---|---|---|---|---|---|---|'];
for (const r of rows) {
  md.push(`| ${r.f.id} | ${r.f.title} | ${r.body?.outcome ?? ''} | ${r.body?.route ?? ''} | ${r.body?.category ?? ''} | ${r.body?.confidence ?? ''} | ${r.ok ? '✅' : `❌ ${r.detail}`} |`);
}
md.push('', 'Also check by hand after the run: rows in Subscriptions / Incidents / ReviewQueue / RunLog, Todoist tasks, alert messages (see TEST_PLAN.md).', '');
mkdirSync(path.join(ROOT, 'tests', 'results'), { recursive: true });
writeFileSync(path.join(ROOT, 'tests', 'results', `acceptance-${date}.md`), md.join('\n'));
console.log(`\n${passed}/${rows.length} passed. Report: tests/results/acceptance-${date}.md`);
process.exit(passed === rows.length ? 0 : 1);
