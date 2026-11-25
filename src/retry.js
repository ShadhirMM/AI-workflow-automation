// Retry policy shared by every external call (Claude, Sheets, Todoist, alert channel).
// In Make this is the "Break" error handler with automatic retries; permanent
// errors go straight to the dead-letter route.

export class PermanentError extends Error {}

/** 'temporary' errors are retried; 'permanent' ones are not. */
export function classifyError(err, retryCfg) {
  if (err instanceof PermanentError) return 'permanent';
  if (err?.status && retryCfg.temporaryStatuses.includes(err.status)) return 'temporary';
  if (err?.code && retryCfg.temporaryCodes.includes(err.code)) return 'temporary';
  if (err?.status) return 'permanent';
  // Unknown error with no status: treat as temporary once, the attempt cap stops loops.
  return 'temporary';
}

/** Root-cause hint shown in alerts, so the operator knows what to check first. */
export function nextStepFor(err) {
  const s = err?.status;
  if (s === 401) return 'Check the API key / connection credentials in Make, then replay the item (S5).';
  if (s === 403) return 'Check the account permissions for this connection, then replay the item (S5).';
  if (s === 404) return 'Check the configured ID (sheet, project, URL) still exists, then replay the item (S5).';
  if (s === 400) return 'Inspect the request payload in the Make execution log; fix the mapping, then replay (S5).';
  if (s === 429) return 'Rate limited. Retries exhausted: check usage limits / plan quota, then replay (S5).';
  if (s === 529 || (s >= 500 && s < 600)) return 'Provider error. Check the provider status page; replay (S5) when it recovers.';
  return 'Open the Make execution log for this run, find the failing module, fix the cause, then replay (S5).';
}

/**
 * Run fn with retries. Returns { value, attempts } or throws the last error
 * with err.attempts and err.classification set.
 */
export async function withRetry(fn, retryCfg, { sleep, onRetry } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (err) {
      const classification = classifyError(err, retryCfg);
      const retriesUsed = attempt - 1;
      if (classification === 'permanent' || retriesUsed >= retryCfg.maxAttempts) {
        err.attempts = attempt;
        err.classification = classification;
        err.exhausted = classification === 'temporary';
        throw err;
      }
      const delayMs = retryCfg.intervalsSeconds[retriesUsed] * 1000;
      onRetry?.({ attempt, delayMs, err });
      await wait(delayMs);
    }
  }
}
