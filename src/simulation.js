// Runs every fixture through the full S1 pipeline with the mock Claude and
// in-memory sinks, then runs S2 (renewals), S3 (health), S4 (watchdog) and an
// S5 replay. Returns per-fixture results compared with the expected outcome.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadPrompt, loadSchema } from './config.js';
import { createPipeline } from './pipeline.js';
import { MemoryStore } from './store.js';
import { createMockClaude, createMemorySinks } from './sim.js';
import { dueRenewals, computeHealth, checkWatchdog } from './scheduled.js';
import { formatHealthReport, formatRenewalDigest } from './alerts.js';

export function loadFixtures() {
  return JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'emails.json'), 'utf8')).fixtures;
}

/** A clock that starts at `start` and moves 2 s per call; sleeps only add to `waited`. */
export function fakeClock(start = '2026-11-25T04:00:00Z') {
  let t = Date.parse(start);
  const clock = {
    waitedMs: 0,
    now: () => { t += 2000; return new Date(t); },
    sleep: async (ms) => { clock.waitedMs += ms; t += ms; },
  };
  return clock;
}

export function compare(fixture, result) {
  const exp = fixture.expected;
  const problems = [];
  if (result.outcome !== exp.outcome) problems.push(`outcome ${result.outcome} ≠ ${exp.outcome}`);
  if (exp.route && result.route !== undefined && result.route !== exp.route) problems.push(`route ${result.route} ≠ ${exp.route}`);
  if (exp.stage && result.stage !== exp.stage) problems.push(`stage ${result.stage} ≠ ${exp.stage}`);
  if (exp.retries !== undefined && result.retries !== exp.retries) problems.push(`retries ${result.retries} ≠ ${exp.retries}`);
  if (exp.reasonIncludes && !(result.reasons ?? []).join(' | ').includes(exp.reasonIncludes)) {
    problems.push(`reasons do not mention "${exp.reasonIncludes}"`);
  }
  if (exp.alert) {
    const alert = result.actions?.find((a) => a.type === 'alert');
    if (alert?.alert.level !== exp.alert) problems.push(`alert level ${alert?.alert.level} ≠ ${exp.alert}`);
  }
  return problems;
}

export async function runSimulation({ fixtures = loadFixtures() } = {}) {
  const config = loadConfig();
  const prompt = loadPrompt();
  const schema = loadSchema();
  const clock = fakeClock();
  const store = new MemoryStore();
  const mock = createMockClaude(fixtures);
  const mem = createMemorySinks();
  const pipeline = createPipeline({
    config, prompt, schema, callClaude: mock.callClaude, sinks: mem.sinks, store, now: clock.now, sleep: clock.sleep,
  });

  // S4 sent the canary at 07:00 Dubai time (03:00Z), before this batch.
  store.set('canarySentAt', '2026-11-25T03:00:00.000Z');

  const results = [];
  for (const f of fixtures) {
    mem.setFaults(f.sinkFaults);
    const result = await pipeline.processItem(f.email);
    mem.setFaults({});
    if (result.outcome === 'dead_letter') {
      const dl = mem.state.sheets.DeadLetter.find((d) => d.id === result.deadLetterId);
      result.attempts = dl.attempts;
    }
    const problems = compare(f, result);
    if (f.expected.attempts !== undefined && result.attempts !== f.expected.attempts) {
      problems.push(`attempts ${result.attempts} ≠ ${f.expected.attempts}`);
    }
    results.push({ id: f.id, title: f.title, expected: f.expected, result, problems });
  }

  // S5: Todoist project fixed → replay the F30 dead letter.
  const f30 = results.find((r) => r.id === 'F30');
  let replay = null;
  if (f30?.result.deadLetterId) {
    const entry = mem.state.sheets.DeadLetter.find((d) => d.id === f30.result.deadLetterId);
    const before = mem.state.sheets.Subscriptions.filter((r) => r.message_id === entry.message_id).length;
    const out = await pipeline.replay(entry.id, entry);
    const after = mem.state.sheets.Subscriptions.filter((r) => r.message_id === entry.message_id).length;
    const tasks = mem.state.tasks.filter((t) => t.description.includes(entry.message_id)).length;
    replay = { deadLetterId: entry.id, outcome: out.outcome, sheetRowsBefore: before, sheetRowsAfter: after, tasks, status: entry.status };
  }

  const now = clock.now();
  const today = '2026-11-25';
  const renewals = dueRenewals(mem.state.sheets.Subscriptions, today, config.schedules.renewalWarningDays);
  const watchdog = checkWatchdog({
    canarySentAt: store.get('canarySentAt'), canarySeenAt: store.get('canarySeenAt'),
    now, maxDelayMinutes: config.schedules.watchdogMaxCanaryDelayMinutes,
  });
  const health = computeHealth({
    runLog: mem.state.sheets.RunLog, deadLetters: mem.state.sheets.DeadLetter,
    reviewQueue: mem.state.sheets.ReviewQueue, lastRunAt: now.toISOString(),
    watchdogFired: watchdog.fired, now, config,
  });

  return {
    results,
    replay,
    renewals,
    renewalDigest: formatRenewalDigest(renewals, today),
    watchdog,
    health,
    healthReport: formatHealthReport(health),
    state: mem.state,
    simulatedWaitMs: clock.waitedMs,
    claudeCalls: mock.log.length,
  };
}
