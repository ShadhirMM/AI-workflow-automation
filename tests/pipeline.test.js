import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadPrompt, loadSchema } from '../src/config.js';
import { createPipeline } from '../src/pipeline.js';
import { MemoryStore } from '../src/store.js';
import { createMockClaude, createMemorySinks } from '../src/sim.js';
import { runSimulation, loadFixtures, fakeClock } from '../src/simulation.js';
import { scanText } from '../tools/check-secrets.js';

const fixtures = loadFixtures();
const byId = Object.fromEntries(fixtures.map((f) => [f.id, f]));

function setup(list = fixtures) {
  const clock = fakeClock();
  const mock = createMockClaude(list);
  const mem = createMemorySinks();
  const store = new MemoryStore();
  const pipeline = createPipeline({
    config: loadConfig(), prompt: loadPrompt(), schema: loadSchema(),
    callClaude: mock.callClaude, sinks: mem.sinks, store, now: clock.now, sleep: clock.sleep,
  });
  return { pipeline, mem, mock, store, clock };
}

test('every fixture behaves as expected in the full simulation', async () => {
  const sim = await runSimulation();
  const failures = sim.results.filter((r) => r.problems.length).map((r) => `${r.id}: ${r.problems.join('; ')}`);
  assert.deepEqual(failures, []);
  assert.equal(sim.results.length, 31);
  assert.equal(sim.watchdog.fired, false);
  assert.equal(sim.health.status, 'ALERT', 'two deliberate dead letters stay open');
  assert.deepEqual(sim.renewals.map((r) => r.daysLeft), [7, 30]);
});

test('duplicate delivery is skipped and does not call Claude', async () => {
  const { pipeline, mock, mem } = setup();
  await pipeline.processItem(byId.F01.email);
  const r = await pipeline.processItem(byId.F23.email);
  assert.equal(r.outcome, 'duplicate');
  assert.equal(mock.log.length, 1);
  assert.equal(mem.state.sheets.Subscriptions.length, 1);
});

test('replay after a partial failure does not duplicate the finished actions', async () => {
  const { pipeline, mem } = setup();
  mem.setFaults(byId.F30.sinkFaults);
  const first = await pipeline.processItem(byId.F30.email);
  assert.equal(first.outcome, 'dead_letter');
  assert.equal(first.stage, 'action:todoist');
  assert.equal(mem.state.sheets.Subscriptions.length, 1, 'sheet row was written before the failure');
  assert.equal(mem.state.tasks.length, 0);

  mem.setFaults({}); // root cause fixed
  const dl = mem.state.sheets.DeadLetter[0];
  const again = await pipeline.replay(dl.id, dl);
  assert.equal(again.outcome, 'routed');
  assert.equal(mem.state.sheets.Subscriptions.length, 1, 'no duplicate row');
  assert.equal(mem.state.tasks.length, 1);
  assert.equal(dl.status, 'replayed');

  const third = await pipeline.processItem(byId.F30.email);
  assert.equal(third.outcome, 'duplicate');
});

test('temporary sink errors are retried; failure alert falls back to email when the alert channel is down', async () => {
  const { pipeline, mem } = setup();
  mem.setFaults({ sheet: [{ status: 503 }] });
  const ok = await pipeline.processItem(byId.F04.email);
  assert.equal(ok.outcome, 'routed');
  assert.equal(ok.retries, 1);

  // Bad API key, and Slack is down too (4 failed alert attempts) → email fallback.
  mem.setFaults({ alert: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }] });
  const r = await pipeline.processItem(byId.F26.email);
  assert.equal(r.outcome, 'dead_letter');
  assert.equal(r.alertedVia, 'email');
  assert.equal(mem.state.emails.length, 1);
  assert.match(mem.state.emails[0].text, /401/);
});

test('failure alert names the stage, the error, the dead-letter row and the next step', async () => {
  const { pipeline } = setup();
  const r = await pipeline.processItem(byId.F25.email);
  assert.match(r.alertText, /stage "claude"/);
  assert.match(r.alertText, /529 overloaded_error/);
  assert.match(r.alertText, /temporary, retries exhausted; attempts: 4/);
  assert.match(r.alertText, /DeadLetter DL001/);
  assert.match(r.alertText, /status page/);
});

test('canary records a heartbeat without calling Claude', async () => {
  const { pipeline, mock, store } = setup();
  const r = await pipeline.processItem(byId.F31.email);
  assert.equal(r.outcome, 'heartbeat');
  assert.equal(mock.log.length, 0);
  assert.ok(store.get('canarySeenAt'));
});

test('every log row and dead letter keeps the message ID for tracing', async () => {
  const sim = await runSimulation();
  for (const row of sim.state.sheets.RunLog) assert.ok(row.message_id, 'RunLog row without message_id');
  for (const row of sim.state.sheets.DeadLetter) assert.ok(row.message_id && row.stage && row.error_message);
});

test('secret scanner finds planted secrets and ignores clean text', () => {
  // Built at runtime so this file itself contains no secret-shaped strings.
  const fake = ['sk-ant-', 'api03-', 'A'.repeat(30)].join('');
  assert.deepEqual(scanText(`key=${fake}`).map((h) => h.name), ['Anthropic API key']);
  assert.equal(scanText('"__IMTCONN__": 1234567').length, 1);
  assert.equal(scanText('"__IMTCONN__": null').length, 0);
  assert.equal(scanText('nothing to see here').length, 0);
});
