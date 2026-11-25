import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { classifyError, withRetry, nextStepFor, PermanentError } from '../src/retry.js';
import { planActions, planReview, taskDueDate, addDays } from '../src/router.js';
import { dueRenewals, computeHealth, checkWatchdog } from '../src/scheduled.js';
import { formatRenewalDigest, formatHealthReport } from '../src/alerts.js';

const config = loadConfig();
const err = (status, code) => Object.assign(new Error('x'), { status, code });

test('classifyError: temporary vs permanent', () => {
  for (const s of [429, 500, 502, 503, 504, 529, 408]) assert.equal(classifyError(err(s), config.retry), 'temporary', String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(classifyError(err(s), config.retry), 'permanent', String(s));
  assert.equal(classifyError(err(undefined, 'ETIMEDOUT'), config.retry), 'temporary');
  assert.equal(classifyError(new PermanentError('no'), config.retry), 'permanent');
});

test('withRetry: succeeds after temporary errors, waits the configured intervals', async () => {
  const waits = [];
  let n = 0;
  const { value, attempts } = await withRetry(async () => { n += 1; if (n < 3) throw err(429); return 'ok'; },
    config.retry, { sleep: async (ms) => waits.push(ms) });
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [15000, 60000]);
});

test('withRetry: stops after maxAttempts retries and marks the error exhausted', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw err(503); }, config.retry, { sleep: async () => {} }),
    (e) => e.attempts === 4 && e.exhausted === true && e.classification === 'temporary');
  assert.equal(n, 4);
});

test('withRetry: permanent errors are not retried', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n += 1; throw err(401); }, config.retry, { sleep: async () => {} }),
    (e) => e.attempts === 1 && e.classification === 'permanent');
  assert.equal(n, 1);
});

test('nextStepFor gives a root-cause hint per error', () => {
  assert.match(nextStepFor(err(401)), /API key/);
  assert.match(nextStepFor(err(404)), /ID/);
  assert.match(nextStepFor(err(529)), /status page/);
  assert.match(nextStepFor(err(undefined, 'ECONNRESET')), /execution log/);
});

const now = new Date('2026-11-25T04:00:00Z');
const base = {
  confidence: 0.95, summary: 'sum', vendor: 'V', service: 'S', amount: 10, currency: 'USD', renewal_date: null,
  due_date: null, ticket_number: null, incident_start: null, urgency: 'normal', suggested_action: 'do',
  needs_human_review: false, review_reason: null,
};
const email = { messageId: '<m1>', from: 'a@b.example', subject: 'Subj', date: '2026-11-25T08:00:00+04:00' };

test('router: renewal → register row + task 14 days before renewal', () => {
  const { route, actions } = planActions({ ...base, category: 'subscription_renewal', renewal_date: '2027-01-14' }, email, { config, now });
  assert.equal(route, 'renewal');
  assert.deepEqual(actions.map((a) => a.type), ['sheet', 'todoist']);
  assert.equal(actions[0].tab, 'Subscriptions');
  assert.equal(actions[1].task.due_date, '2026-12-31');
});

test('router: task due date is never in the past', () => {
  assert.equal(taskDueDate('2026-11-30', 14, '2026-11-25'), '2026-11-25');
  assert.equal(taskDueDate(null, 14, '2026-11-25'), '2026-11-25');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('router: outage and security raise alerts; security is always URGENT and p1', () => {
  const out = planActions({ ...base, category: 'outage_notice', urgency: 'critical' }, email, { config, now });
  assert.deepEqual(out.actions.map((a) => a.type), ['sheet', 'alert', 'todoist']);
  assert.equal(out.actions[1].alert.level, 'URGENT');
  const deg = planActions({ ...base, category: 'outage_notice', urgency: 'high' }, email, { config, now });
  assert.equal(deg.actions[1].alert.level, 'NOTICE');
  const sec = planActions({ ...base, category: 'security_alert', urgency: 'high' }, email, { config, now });
  assert.equal(sec.actions[1].alert.level, 'URGENT');
  assert.equal(sec.actions[2].task.priority, 'p1');
});

test('router: access request → task + draft reply (never sent automatically); other → nothing', () => {
  const acc = planActions({ ...base, category: 'access_request' }, email, { config, now });
  assert.deepEqual(acc.actions.map((a) => a.type), ['todoist', 'draft']);
  assert.equal(planActions({ ...base, category: 'other' }, email, { config, now }).actions.length, 0);
});

test('router: review → ReviewQueue row + review task', () => {
  const r = planReview(email, ['low confidence'], { ...base, category: 'other' }, { config, now });
  assert.equal(r.route, 'review');
  assert.equal(r.actions[0].tab, 'ReviewQueue');
  assert.match(r.actions[1].task.content, /^Review AI triage/);
});

test('S2: renewals due in exactly 30/7/1 days or overdue', () => {
  const rows = [
    { kind: 'renewal', status: 'active', vendor: 'A', service: 'a', renewal_date: '2026-12-25' },
    { kind: 'renewal', status: 'active', vendor: 'B', service: 'b', renewal_date: '2026-12-02' },
    { kind: 'renewal', status: 'active', vendor: 'C', service: 'c', renewal_date: '2026-11-26' },
    { kind: 'renewal', status: 'active', vendor: 'D', service: 'd', renewal_date: '2026-12-10' },
    { kind: 'renewal', status: 'active', vendor: 'E', service: 'e', renewal_date: '2026-11-20' },
    { kind: 'renewal', status: 'cancelled', vendor: 'F', service: 'f', renewal_date: '2026-12-02' },
    { kind: 'invoice', status: 'invoice_received', vendor: 'G', service: 'g', due_date: '2026-12-02' },
  ];
  const due = dueRenewals(rows, '2026-11-25', [30, 7, 1]);
  assert.deepEqual(due.map((d) => [d.vendor, d.daysLeft]), [['E', -5], ['C', 1], ['B', 7], ['A', 30]]);
  assert.match(formatRenewalDigest(due, '2026-11-25'), /4 item\(s\)[\s\S]*5 day\(s\) overdue/);
  assert.match(formatRenewalDigest([], '2026-11-25'), /^\[OK\]/);
});

test('S3: health status OK / WARNING / ALERT', () => {
  const t = '2026-11-25T03:00:00Z';
  const args = { runLog: [{ time: t, outcome: 'routed', retries: 0 }], deadLetters: [], reviewQueue: [], lastRunAt: t, watchdogFired: false, now, config };
  assert.equal(computeHealth(args).status, 'OK');
  assert.equal(computeHealth({ ...args, runLog: [{ time: t, outcome: 'routed', retries: 2 }] }).status, 'WARNING');
  assert.equal(computeHealth({ ...args, reviewQueue: Array(5).fill({ status: 'open' }) }).status, 'WARNING');
  assert.equal(computeHealth({ ...args, deadLetters: [{ status: 'open' }] }).status, 'ALERT');
  assert.equal(computeHealth({ ...args, deadLetters: [{ status: 'replayed' }] }).status, 'OK');
  assert.equal(computeHealth({ ...args, watchdogFired: true }).status, 'ALERT');
  assert.equal(computeHealth({ ...args, lastRunAt: '2026-11-23T00:00:00Z' }).status, 'ALERT');
  assert.match(formatHealthReport(computeHealth({ ...args, deadLetters: [{ status: 'open' }] })), /^\[ALERT\][\s\S]*1 open dead letter/);
});

test('S4: watchdog fires only when the canary is late', () => {
  const sent = '2026-11-25T03:00:00Z';
  const at = (iso) => new Date(iso);
  assert.equal(checkWatchdog({ canarySentAt: sent, canarySeenAt: '2026-11-25T03:01:00Z', now: at('2026-11-25T04:00:00Z'), maxDelayMinutes: 20 }).fired, false);
  assert.equal(checkWatchdog({ canarySentAt: sent, canarySeenAt: null, now: at('2026-11-25T03:10:00Z'), maxDelayMinutes: 20 }).fired, false);
  assert.equal(checkWatchdog({ canarySentAt: sent, canarySeenAt: '2026-11-25T02:00:00Z', now: at('2026-11-25T03:30:00Z'), maxDelayMinutes: 20 }).fired, true);
  assert.equal(checkWatchdog({ canarySentAt: null, now: at('2026-11-25T03:30:00Z'), maxDelayMinutes: 20 }).fired, false);
});
