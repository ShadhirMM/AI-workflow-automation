#!/usr/bin/env node
// npm run eval            (needs ANTHROPIC_API_KEY; costs a few cents)
// npm run eval -- F01 F17 (only these fixtures)
//
// Sends each fixture email to the real Claude API with the exact request the
// Make scenario uses, runs the same checks, and reports:
//   - category accuracy and a confusion table
//   - field accuracy (amount, currency, dates, ticket number, vendor)
//   - "confident but wrong": answers that PASSED the checks but were wrong.
//     This must be 0 before go-live: those are the errors nobody would see.
// Writes tests/results/eval-<date>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadPrompt, loadSchema } from '../src/config.js';
import { buildEmailBlock } from '../src/clean.js';
import { buildRequest, extractResult, createLiveCaller } from '../src/claude.js';
import { validateResult } from '../src/validate.js';
import { withRetry } from '../src/retry.js';
import { loadFixtures } from '../src/simulation.js';

const FIELDS = ['amount', 'currency', 'renewal_date', 'due_date', 'ticket_number', 'incident_start', 'vendor'];

export function fieldMatches(field, expected, actual) {
  if (field === 'vendor') return typeof actual === 'string' && actual.toLowerCase().includes(String(expected).toLowerCase());
  if (field === 'incident_start') return actual !== null && Date.parse(actual) === Date.parse(expected);
  if (field === 'amount') return typeof actual === 'number' && Math.abs(actual - expected) < 0.005;
  return actual === expected;
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('Set ANTHROPIC_API_KEY first (see .env.example). The offline checks are `npm test` and `npm run simulate`.');
  process.exit(2);
}

const only = new Set(process.argv.slice(2));
const config = loadConfig();
const prompt = loadPrompt();
const schema = loadSchema();
const callClaude = await createLiveCaller(config);
const fixtures = loadFixtures().filter((f) => !f.expected.skipLiveEval && (!only.size || only.has(f.id)));

const rows = [];
let usageIn = 0;
let usageOut = 0;
for (const f of fixtures) {
  const block = buildEmailBlock(f.email, config.ai.maxEmailChars);
  const body = buildRequest(block.text, { config, prompt, schema });
  const t0 = Date.now();
  let response;
  try {
    ({ value: response } = await withRetry(() => callClaude(body), config.retry, {
      onRetry: ({ delayMs, err }) => console.log(`  ${f.id}: ${err.status ?? err.code} — retrying in ${delayMs / 1000}s`),
    }));
  } catch (err) {
    rows.push({ f, error: `${err.status ?? err.code}: ${err.message}` });
    console.log(`${f.id} ERROR ${err.message}`);
    continue;
  }
  usageIn += response.usage?.input_tokens ?? 0;
  usageOut += response.usage?.output_tokens ?? 0;
  const ai = extractResult(response);
  if (!ai.ok) {
    rows.push({ f, error: `${ai.kind}: ${ai.detail}` });
    console.log(`${f.id} ${ai.kind}`);
    continue;
  }
  const check = validateResult(ai.data, { email: f.email, cleanText: block.body, schema, config });
  const exp = f.expected;
  const categoryOk = !exp.category || ai.data.category === exp.category;
  const fieldResults = Object.entries(exp.fields ?? {}).map(([k, v]) => ({ k, v, got: ai.data[k], ok: fieldMatches(k, v, ai.data[k]) }));
  const allOk = categoryOk && fieldResults.every((r) => r.ok);
  const expectedRoute = exp.liveRoute ?? exp.route;
  const actualRoute = check.decision === 'accept' ? routeOf(ai.data.category) : 'review';
  rows.push({
    f, data: ai.data, check, categoryOk, fieldResults, allOk, ms: Date.now() - t0,
    confidentButWrong: check.decision === 'accept' && !allOk,
    routeOk: actualRoute === expectedRoute, actualRoute, expectedRoute,
  });
  console.log(`${f.id} ${ai.data.category} conf=${ai.data.confidence} ${check.decision}${allOk ? '' : '  ← mismatch'}`);
}

function routeOf(category) {
  return { subscription_renewal: 'renewal', vendor_invoice: 'invoice', outage_notice: 'outage', security_alert: 'security', access_request: 'access', other: 'log_only' }[category];
}

const scored = rows.filter((r) => !r.error);
const catOk = scored.filter((r) => r.categoryOk).length;
const fieldTotal = scored.reduce((n, r) => n + r.fieldResults.length, 0);
const fieldOk = scored.reduce((n, r) => n + r.fieldResults.filter((x) => x.ok).length, 0);
const cbw = scored.filter((r) => r.confidentButWrong);
const routeOk = scored.filter((r) => r.routeOk).length;

const cats = [...new Set(fixtures.map((f) => f.expected.category).filter(Boolean))];
const confusion = {};
for (const r of scored) {
  const e = r.f.expected.category ?? '-';
  confusion[e] ??= {};
  confusion[e][r.data.category] = (confusion[e][r.data.category] ?? 0) + 1;
}

const date = new Date().toISOString().slice(0, 10);
const md = [];
md.push(`# Prompt evaluation — ${date}`, '');
md.push(`Model: \`${config.ai.model}\` · effort \`${config.ai.effort}\` · ${fixtures.length} fixtures · tokens in/out: ${usageIn}/${usageOut}`, '');
md.push('| Metric | Result | Target |', '|---|---|---|');
md.push(`| Category accuracy | ${catOk}/${scored.length} | ≥ 95% |`);
md.push(`| Field accuracy | ${fieldOk}/${fieldTotal} | ≥ 95% |`);
md.push(`| Route matches expected (after checks) | ${routeOk}/${scored.length} | all |`);
md.push(`| **Confident but wrong** (passed checks, wrong answer) | **${cbw.length}** | **0** |`);
md.push(`| Errors / unreadable replies | ${rows.length - scored.length} | 0 |`, '');
md.push('## Confusion table (rows = expected, columns = model)', '');
md.push(`| expected \\ got | ${cats.join(' | ')} |`, `|---|${cats.map(() => '---').join('|')}|`);
for (const e of cats) md.push(`| ${e} | ${cats.map((c) => confusion[e]?.[c] ?? 0).join(' | ')} |`);
md.push('', '## Per fixture', '', '| ID | Expected | Got | Conf. | Checks | Route | Fields |', '|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) { md.push(`| ${r.f.id} | ${r.f.expected.category ?? ''} | ERROR | | ${r.error} | | |`); continue; }
  const fields = r.fieldResults.map((x) => `${x.ok ? '✅' : '❌'} ${x.k}${x.ok ? '' : ` (got ${JSON.stringify(x.got)}, want ${JSON.stringify(x.v)})`}`).join('<br>');
  md.push(`| ${r.f.id} | ${r.f.expected.category} | ${r.data.category}${r.categoryOk ? '' : ' ❌'} | ${r.data.confidence} | ${r.check.decision}${r.check.reasons.length ? `: ${r.check.reasons.join('; ').replace(/\|/g, '/')}` : ''} | ${r.actualRoute}${r.routeOk ? '' : ` ❌ (want ${r.expectedRoute})`} | ${fields} |`);
}
md.push('');
mkdirSync(path.join(ROOT, 'tests', 'results'), { recursive: true });
const file = path.join(ROOT, 'tests', 'results', `eval-${date}.md`);
writeFileSync(file, md.join('\n'));
console.log(`\nCategory ${catOk}/${scored.length} · fields ${fieldOk}/${fieldTotal} · confident-but-wrong ${cbw.length}\nReport: ${path.relative(ROOT, file)}`);
process.exit(cbw.length ? 1 : 0);
