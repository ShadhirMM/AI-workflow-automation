#!/usr/bin/env node
// npm run export:make
// Generates the files you paste into Make and Google Sheets, from the same
// config/prompt/schema the code uses, so the two can never drift apart:
//   make/http/anthropic-request.json   raw body for the HTTP module (S1)
//   make/http/anthropic-headers.json   headers for the HTTP module
//   make/data-structures/*.json        sample JSON for Make "Generate data structure"
//   sheets/*.csv                       header row for each Google Sheet tab
// tests/make-assets.test.js fails if these files are out of date.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, loadPrompt, loadSchema } from '../src/config.js';
import { buildRequest, requestHeaders } from '../src/claude.js';
import { COLUMNS } from '../src/sheetColumns.js';
import { toCsv } from '../src/sim.js';

// Make's "JSON > Create JSON" module outputs {"role":"user","content":"<escaped email>"}.
// That string is inserted where this placeholder sits in the raw body.
export const MESSAGE_PLACEHOLDER = '__MAKE_CREATE_JSON_OUTPUT__';

export function makeAssets() {
  const config = loadConfig();
  const prompt = loadPrompt();
  const schema = loadSchema();

  const body = buildRequest('', { config, prompt, schema });
  body.messages = [MESSAGE_PLACEHOLDER];
  const bodyText = JSON.stringify(body, null, 2).replace(`"${MESSAGE_PLACEHOLDER}"`, '{{CREATE_JSON.json}}');

  const sampleOutput = {
    category: 'subscription_renewal', confidence: 0.95, summary: 'Example', vendor: 'Example', service: 'Example',
    amount: 10.5, currency: 'USD', renewal_date: '2027-01-01', due_date: '2027-01-01', ticket_number: 'X-1',
    incident_start: '2026-11-25T07:42:00+04:00', urgency: 'normal', suggested_action: 'Example',
    needs_human_review: false, review_reason: 'Example',
  };
  const webhookInput = {
    messageId: '<example@domain.example>', from: 'Vendor <billing@vendor.example>', to: 'it@familyoffice-demo.example',
    date: '2026-11-25T07:10:00+04:00', subject: 'Example subject', body: 'Example body', canary: false,
  };
  const webhookResponse = {
    outcome: 'routed', route: 'renewal', category: 'subscription_renewal', confidence: 0.95, reasons: 'Example',
  };

  const files = {
    'make/http/anthropic-request.json': bodyText + '\n',
    'make/http/anthropic-headers.json': JSON.stringify(requestHeaders(config, '{{keychain: Anthropic API key}}'), null, 2) + '\n',
    'make/data-structures/triage-output.sample.json': JSON.stringify(sampleOutput, null, 2) + '\n',
    'make/data-structures/user-message.sample.json': JSON.stringify({ role: 'user', content: 'Example' }, null, 2) + '\n',
    'make/data-structures/webhook-input.sample.json': JSON.stringify(webhookInput, null, 2) + '\n',
    'make/data-structures/webhook-response.sample.json': JSON.stringify(webhookResponse, null, 2) + '\n',
  };
  for (const [tab, cols] of Object.entries(COLUMNS)) {
    if (tab === 'Config') continue;
    files[`sheets/${tab}.csv`] = toCsv([], cols);
  }
  const configRows = [
    { key: 'confidence_threshold', value: config.validation.confidenceThreshold, notes: 'Below this, items go to ReviewQueue' },
    { key: 'renewal_warning_days', value: config.schedules.renewalWarningDays.join(','), notes: 'S2 warns exactly this many days before renewal' },
    { key: 'review_queue_warning_at', value: config.health.reviewQueueWarningAt, notes: 'S3 WARNING threshold' },
    { key: 'trusted_domains', value: [...config.validation.internalDomains, ...config.validation.trustedVendorDomains].join(','), notes: 'Senders allowed for renewals and invoices' },
    { key: 'alert_channel', value: 'slack-webhook', notes: 'Fallback: email' },
  ];
  files['sheets/Config.csv'] = toCsv(configRows, COLUMNS.Config);
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'tools', 'export-make-assets.js')) {
  for (const [rel, text] of Object.entries(makeAssets())) {
    const full = path.join(ROOT, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    console.log(`wrote ${rel}`);
  }
}
