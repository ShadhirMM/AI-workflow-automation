import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadSchema } from '../src/config.js';
import { validateResult, amountAppearsInText, normaliseNumbers } from '../src/validate.js';
import { checkSchema, isRealDate } from '../src/schemaCheck.js';

const config = loadConfig();
const schema = loadSchema();

const good = () => ({
  category: 'subscription_renewal', confidence: 0.9, summary: 's', vendor: 'VaultPass', service: 'Teams',
  amount: 1320, currency: 'AED', renewal_date: '2026-12-02', due_date: null, ticket_number: null,
  incident_start: null, urgency: 'normal', suggested_action: 'a', needs_human_review: false, review_reason: null,
});
const email = {
  from: 'VaultPass <no-reply@vaultpass.example>', subject: 'Renewal', date: '2026-11-25T07:00:00+04:00',
};
const text = 'Your plan renews on 2026-12-02. You will be charged AED 1,320.00.';
const ctx = { email, cleanText: text, schema, config };

test('accepts a correct, confident answer', () => {
  assert.deepEqual(validateResult(good(), ctx), { decision: 'accept', reasons: [] });
});

test('schema: rejects wrong types, unknown fields, bad enum, fake dates', () => {
  assert.ok(checkSchema({ ...good(), amount: '1320' }, schema).some((e) => e.includes('$.amount')));
  assert.ok(checkSchema({ ...good(), extra: 1 }, schema).some((e) => e.includes('not allowed')));
  assert.ok(checkSchema({ ...good(), category: 'invoice' }, schema).some((e) => e.includes('not one of')));
  assert.ok(checkSchema({ ...good(), renewal_date: '2026-02-30' }, schema).length > 0);
  const missing = good();
  delete missing.vendor;
  assert.ok(checkSchema(missing, schema).some((e) => e.includes('vendor: missing')));
  assert.equal(isRealDate('2028-02-29'), true);
  assert.equal(isRealDate('2027-02-29'), false);
});

test('schema failure goes to review', () => {
  const r = validateResult({ ...good(), urgency: 'urgent' }, ctx);
  assert.equal(r.decision, 'review');
  assert.match(r.reasons[0], /^schema:/);
});

test('low confidence and AI-requested review go to review', () => {
  assert.match(validateResult({ ...good(), confidence: 0.5 }, ctx).reasons.join(), /low confidence 0.50/);
  const r = validateResult({ ...good(), needs_human_review: true, review_reason: 'odd' }, ctx);
  assert.match(r.reasons.join(), /AI asked for review: odd/);
  assert.match(validateResult({ ...good(), confidence: 1.4 }, ctx).reasons.join(), /outside 0–1/);
});

test('missing required field for the category goes to review', () => {
  const r = validateResult({ ...good(), renewal_date: null }, ctx);
  assert.match(r.reasons.join(), /missing renewal_date/);
});

test('amount must appear in the email (catches a confident wrong number)', () => {
  const r = validateResult({ ...good(), amount: 1230 }, ctx);
  assert.match(r.reasons.join(), /amount 1230 not found/);
  assert.equal(amountAppearsInText(1320, text), true);
  assert.equal(amountAppearsInText(299.95, 'USD 299.95 annually'), true);
  assert.equal(amountAppearsInText(29.95, 'USD 299.95 annually'), false, 'must not match inside another number');
  assert.equal(amountAppearsInText(149.9, 'USD 149.90 per year'), true);
  assert.equal(amountAppearsInText(null, 'anything'), true);
});

test('Arabic-Indic digits are normalised', () => {
  assert.equal(normaliseNumbers('٣١٥٫٠٠'), '315.00');
  assert.equal(normaliseNumbers('۱۲۳'), '123');
  assert.equal(amountAppearsInText(315, 'المبلغ المستحق: ٣١٥٫٠٠ درهم'), true);
});

test('dates far outside the expected range go to review', () => {
  const r = validateResult({ ...good(), renewal_date: '2031-01-01', amount: 1320 }, ctx);
  assert.match(r.reasons.join(), /outside the expected range/);
});

test('renewals and invoices from untrusted domains go to review; internal forwards are fine', () => {
  const bad = validateResult(good(), { ...ctx, email: { ...email, from: 'x <billing@vaultpass-billing.example.net>' } });
  assert.match(bad.reasons.join(), /sender domain vaultpass-billing.example.net/);
  const internal = validateResult(good(), { ...ctx, email: { ...email, from: 'OM <om@familyoffice-demo.example>' } });
  assert.equal(internal.decision, 'accept');
  // Outage notices are not sender-checked (they still need a human to act).
  const outage = { ...good(), category: 'outage_notice', renewal_date: null, amount: null, currency: null };
  assert.equal(validateResult(outage, { ...ctx, email: { ...email, from: 'x <noc@unknown.example>' } }).decision, 'accept');
});
