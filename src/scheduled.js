// Logic for the scheduled scenarios:
// S2 renewal check, S3 health report, S4 watchdog (canary).

function dayDiff(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * S2: subscriptions that renew exactly N days from today (N in warningDays),
 * plus any active renewal already past its date. Exact match means each
 * window fires once, so a daily run does not repeat the same warning.
 */
export function dueRenewals(rows, today, warningDays) {
  const out = [];
  for (const row of rows) {
    if (row.kind !== 'renewal' || !row.renewal_date || row.status !== 'active') continue;
    const daysLeft = dayDiff(today, row.renewal_date);
    if (warningDays.includes(daysLeft) || daysLeft < 0) out.push({ ...row, daysLeft });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * S3: OK / WARNING / ALERT for the automation itself.
 * ALERT: any open dead letter, watchdog fired, or no run for maxHoursWithoutRun.
 * WARNING: review queue at or above the threshold, or any retry was needed.
 */
export function computeHealth({ runLog, deadLetters, reviewQueue, lastRunAt, watchdogFired, now, config }) {
  const since = now.getTime() - 24 * 3_600_000;
  const recent = runLog.filter((r) => Date.parse(r.time) >= since);
  const openDeadLetters = deadLetters.filter((d) => d.status === 'open').length;
  const openReview = reviewQueue.filter((r) => r.status === 'open').length;
  const retriesUsed = recent.reduce((n, r) => n + (Number(r.retries) || 0), 0);
  const reasons = [];
  let status = 'OK';

  const hoursSinceRun = lastRunAt ? (now.getTime() - Date.parse(lastRunAt)) / 3_600_000 : Infinity;
  if (openDeadLetters > 0) reasons.push(`${openDeadLetters} open dead letter(s)`);
  if (watchdogFired) reasons.push('watchdog: canary not processed');
  if (hoursSinceRun > config.health.maxHoursWithoutRun) reasons.push(`no run for ${config.health.maxHoursWithoutRun}h+`);
  if (reasons.length) status = 'ALERT';

  const warn = [];
  if (openReview >= config.health.reviewQueueWarningAt) warn.push(`review queue has ${openReview} open item(s)`);
  if (retriesUsed > 0) warn.push(`${retriesUsed} retry(ies) needed in 24h`);
  if (status === 'OK' && warn.length) status = 'WARNING';
  reasons.push(...warn);

  return {
    status,
    date: now.toISOString().slice(0, 10),
    processed: recent.filter((r) => r.outcome !== 'duplicate' && r.outcome !== 'heartbeat').length,
    routed: recent.filter((r) => r.outcome === 'routed').length,
    review: recent.filter((r) => r.outcome === 'review').length,
    duplicates: recent.filter((r) => r.outcome === 'duplicate').length,
    retriesUsed,
    openDeadLetters,
    openReview,
    reasons,
  };
}

/**
 * S4 watchdog. Each run sends a canary item to S1 and checks the previous one.
 * Fires when the last canary was sent more than maxDelay minutes ago and S1
 * has not recorded it (S1 stopped, was disabled, or ran out of operations).
 */
export function checkWatchdog({ canarySentAt, canarySeenAt, now, maxDelayMinutes }) {
  if (!canarySentAt) return { fired: false, reason: 'no canary sent yet' };
  const ageMin = (now.getTime() - Date.parse(canarySentAt)) / 60_000;
  const seen = canarySeenAt && Date.parse(canarySeenAt) >= Date.parse(canarySentAt);
  if (seen) return { fired: false, reason: 'canary processed' };
  if (ageMin <= maxDelayMinutes) return { fired: false, reason: 'canary still in flight' };
  return { fired: true, reason: `canary sent ${Math.round(ageMin)} min ago was not processed` };
}
