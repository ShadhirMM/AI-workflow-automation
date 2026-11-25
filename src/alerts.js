// Message formats for failure alerts, the daily health report and the renewal digest.
// Plain text so the same text works in Slack, Telegram and email.

export function formatFailureAlert({ scenario, stage, err, email, attempts, deadLetterId, nextStep }) {
  const kind = err.classification === 'permanent' ? 'permanent' : 'temporary, retries exhausted';
  const status = err.status ? `${err.status} ` : err.code ? `${err.code} ` : '';
  return [
    `[ALERT] IT Ops Automation · ${scenario} · stage "${stage}"`,
    `Error: ${status}${err.message} (${kind}; attempts: ${attempts})`,
    `Item: "${email.subject}" (msg ${String(email.messageId).slice(0, 12)}) → DeadLetter ${deadLetterId}`,
    `Next step: ${nextStep}`,
  ].join('\n');
}

export function formatHealthReport(h) {
  const lines = [
    `[${h.status}] IT Ops Automation daily health · ${h.date}`,
    `Processed: ${h.processed} · Routed: ${h.routed} · Review: ${h.review} · Duplicates: ${h.duplicates}`,
    `Retries used: ${h.retriesUsed} · Open dead letters: ${h.openDeadLetters} · Open review items: ${h.openReview}`,
  ];
  if (h.reasons.length) lines.push(`Why: ${h.reasons.join('; ')}`);
  return lines.join('\n');
}

export function formatRenewalDigest(due, today) {
  if (!due.length) return `[OK] Renewal check ${today}: nothing renews in the warning windows.`;
  const lines = [`[NOTICE] Renewal check ${today}: ${due.length} item(s) need attention`];
  for (const d of due) {
    const when = d.daysLeft < 0 ? `${-d.daysLeft} day(s) overdue` : `in ${d.daysLeft} day(s)`;
    const cost = d.amount != null && d.amount !== '' ? ` · ${d.amount} ${d.currency ?? ''}`.trimEnd() : '';
    lines.push(`• ${d.vendor} · ${d.service} renews ${d.renewal_date} (${when})${cost}`);
  }
  return lines.join('\n');
}
