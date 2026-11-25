import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadPrompt, loadSchema, checkConfig } from '../src/config.js';
import { cleanBody, buildEmailBlock, senderDomain, htmlToText } from '../src/clean.js';
import { buildRequest, extractResult, requestHeaders } from '../src/claude.js';
import { makeAssets } from '../tools/export-make-assets.js';

const config = loadConfig();
const prompt = loadPrompt();
const schema = loadSchema();

test('cleanBody strips quoted replies and signatures', () => {
  const body = 'Please renew.\n\n-- \nJane\n\nOn Mon, 1 Dec 2026, Bob wrote:\n> old text';
  assert.equal(cleanBody(body), 'Please renew.');
  assert.equal(cleanBody('line one\n> quoted\nline two'), 'line one\nline two');
});

test('cleanBody keeps forwarded content even below the forwarder signature', () => {
  const body = 'FYI\n\n-- \nOffice Manager\n\n---------- Forwarded message ---------\nRenews on 2027-01-03 for AED 1,140.00.';
  assert.match(cleanBody(body), /AED 1,140.00/);
});

test('HTML emails are converted to text', () => {
  assert.equal(htmlToText('<p>Total: <b>USD&nbsp;5</b></p><script>x()</script>').trim(), 'Total: USD 5');
});

test('email block includes headers and is capped', () => {
  const e = { from: 'a@b.example', to: 'it@x.example', date: 'd', subject: 'S', body: 'x'.repeat(50) };
  const b = buildEmailBlock(e, 10);
  assert.ok(b.truncated);
  assert.match(b.text, /^<email>\nFrom: a@b.example/);
  assert.match(b.text, /\[Body truncated to 10 characters\]\n<\/email>$/);
});

test('senderDomain', () => {
  assert.equal(senderDomain('VaultPass <No-Reply@VaultPass.example>'), 'vaultpass.example');
  assert.equal(senderDomain('plain@host.example'), 'host.example');
  assert.equal(senderDomain('no address'), null);
});

test('request uses structured outputs, low effort and refusal fallbacks', () => {
  const body = buildRequest('<email>x</email>', { config, prompt, schema });
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema, schema);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.temperature, undefined, 'sampling params are rejected by the current API version');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(requestHeaders(config)['anthropic-beta'], config.ai.fallbackBeta);
});

test('schema follows structured-output limits (all objects closed, no numeric/string constraints)', () => {
  const walk = (s) => {
    if (s.type === 'object') assert.equal(s.additionalProperties, false);
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) assert.equal(s[k], undefined, k);
    Object.values(s.properties ?? {}).forEach(walk);
    (s.anyOf ?? []).forEach(walk);
  };
  walk(schema);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
});

test('extractResult handles text, refusal, truncation, bad JSON, empty', () => {
  const ok = extractResult({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] });
  assert.deepEqual(ok.data, { a: 1 });
  assert.equal(extractResult({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }).kind, 'refusal');
  assert.equal(extractResult({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }).kind, 'truncated');
  assert.equal(extractResult({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":' }] }).kind, 'invalid_json');
  assert.equal(extractResult({ stop_reason: 'end_turn', content: [] }).kind, 'empty');
  assert.equal(extractResult(null).kind, 'empty');
});

test('config check catches bad values', () => {
  assert.deepEqual(checkConfig(config), []);
  const bad = structuredClone(config);
  bad.validation.confidenceThreshold = 2;
  bad.retry.intervalsSeconds = [1];
  assert.equal(checkConfig(bad).length, 2);
});

test('Make HTTP body template produces exactly the request the code sends', () => {
  const template = readFileSync(path.join(ROOT, 'make', 'http', 'anthropic-request.json'), 'utf8');
  const emailText = '<email>\nSubject: "quotes" & ünïcödé\nLine 2\n</email>';
  // What Make's "JSON > Create JSON" module outputs for {role, content}:
  const createJsonOutput = JSON.stringify({ role: 'user', content: emailText });
  const filled = JSON.parse(template.replace('{{CREATE_JSON.json}}', createJsonOutput));
  assert.deepEqual(filled, buildRequest(emailText, { config, prompt, schema }));
});

test('generated Make and Sheets files are up to date (run npm run export:make)', () => {
  for (const [rel, text] of Object.entries(makeAssets())) {
    assert.equal(readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'), text, `${rel} is stale`);
  }
});
