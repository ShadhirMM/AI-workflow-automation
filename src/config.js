// Loads config/config.json, the triage prompt and the output schema.
// Everything the pipeline needs to know is read from these three files, so the
// Make scenarios and this reference implementation stay in step.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file = path.join(ROOT, 'config', 'config.json')) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const errors = checkConfig(cfg);
  if (errors.length) throw new Error(`Invalid config: ${errors.join('; ')}`);
  return cfg;
}

export function loadPrompt() {
  return readFileSync(path.join(ROOT, 'prompts', 'triage.md'), 'utf8').trim();
}

export function loadSchema() {
  return JSON.parse(readFileSync(path.join(ROOT, 'prompts', 'triage.schema.json'), 'utf8'));
}

export function checkConfig(cfg) {
  const errors = [];
  const t = cfg?.validation?.confidenceThreshold;
  if (typeof t !== 'number' || t <= 0 || t > 1) errors.push('validation.confidenceThreshold must be in (0, 1]');
  const r = cfg?.retry;
  if (!Number.isInteger(r?.maxAttempts) || r.maxAttempts < 0) errors.push('retry.maxAttempts must be a non-negative integer');
  if (!Array.isArray(r?.intervalsSeconds) || r.intervalsSeconds.length < r?.maxAttempts) {
    errors.push('retry.intervalsSeconds needs one interval per attempt');
  }
  if (!cfg?.ai?.model) errors.push('ai.model is required');
  if (!Array.isArray(cfg?.schedules?.renewalWarningDays)) errors.push('schedules.renewalWarningDays must be a list');
  return errors;
}
