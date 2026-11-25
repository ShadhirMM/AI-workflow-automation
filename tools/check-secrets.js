#!/usr/bin/env node
// npm run check:secrets
// Scans the files that would be committed for API keys, tokens, webhook URLs
// and Make connection IDs. Run before every commit and after exporting a
// blueprint from Make. Exit code 1 if anything is found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Slack webhook URL', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: 'Telegram bot token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'Make webhook URL', re: /hook\.[a-z0-9]+\.make\.com\/[a-z0-9]{20,}/i },
  { name: 'Todoist token', re: /todoist[^\n]{0,30}\b[a-f0-9]{40}\b/i },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Make connection ID in blueprint', re: /"__IMTCONN__"\s*:\s*\d+/ },
  { name: 'Make data store / hook ID in blueprint', re: /"(datastore|hook|__IMTHOOK__)"\s*:\s*\d{3,}/ },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out']);
const SKIP_FILES = new Set(['package-lock.json']);

export function scanText(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const p of PATTERNS) if (p.re.test(line)) hits.push({ line: i + 1, name: p.name });
  });
  return hits;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let found = 0;
  for (const file of walk(root)) {
    if (file === fileURLToPath(import.meta.url) || /\.test\.js$/.test(file)) continue; // patterns/test samples
    if (/\.(png|jpg|jpeg|gif|mp4|xlsx|pdf)$/i.test(file)) continue;
    for (const hit of scanText(readFileSync(file, 'utf8'))) {
      console.error(`${path.relative(root, file)}:${hit.line}  ${hit.name}`);
      found += 1;
    }
  }
  if (found) {
    console.error(`\n${found} possible secret(s) found. Remove them (and scrub blueprints) before committing.`);
    process.exit(1);
  }
  console.log('check:secrets — no secrets found.');
}
