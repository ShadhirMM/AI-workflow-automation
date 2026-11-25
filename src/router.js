// Decides what happens to a validated item: which sheet rows, which Todoist
// task, which alert. Returns a list of actions; the pipeline executes them.
// Mirrors the Router module in Make scenario S1 (one route per category).

export const ROUTES = {
  subscription_renewal: 'renewal',
  vendor_invoice: 'invoice',
  outage_notice: 'outage',
  security_alert: 'security',
  access_request: 'access',
  other: 'log_only',
};

// Todoist: p1 is the most urgent (API priority 4).
const PRIORITY_BY_URGENCY = { critical: 'p1', high: 'p2', normal: 'p3', low: 'p4' };

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date for a task: lead days before the deadline, but never before today. */
export function taskDueDate(deadline, leadDays, today) {
  if (!deadline) return today;
  const due = addDays(deadline, -leadDays);
  return due < today ? today : due;
}

function sourceLink(email) {
  return email.link ?? `msg:${email.messageId}`;
}

export function planActions(result, email, { config, now }) {
  const today = now.toISOString().slice(0, 10);
  const route = ROUTES[result.category];
  const r = config.routing;
  const priority = PRIORITY_BY_URGENCY[result.urgency] ?? 'p3';
  const base = { messageId: email.messageId, source: sourceLink(email) };
  const actions = [];

  const task = (title, due, prio = priority) => ({
    type: 'todoist',
    ...base,
    task: {
      project: r.todoistProject,
      content: title,
      description: `${result.summary}\nNext step: ${result.suggested_action}\nSource: ${base.source}`,
      due_date: due,
      priority: prio,
      labels: ['ai-triage', route],
    },
  });

  switch (route) {
    case 'renewal':
      actions.push({
        type: 'sheet', tab: 'Subscriptions', ...base,
        row: {
          vendor: result.vendor, service: result.service, kind: 'renewal',
          amount: result.amount, currency: result.currency, renewal_date: result.renewal_date,
          status: 'active', source: base.source, message_id: email.messageId, updated: today,
        },
      });
      actions.push(task(`Review renewal: ${result.vendor} ${result.service} (renews ${result.renewal_date})`,
        taskDueDate(result.renewal_date, r.renewalTaskLeadDays, today)));
      break;
    case 'invoice':
      actions.push({
        type: 'sheet', tab: 'Subscriptions', ...base,
        row: {
          vendor: result.vendor, service: result.service ?? '', kind: 'invoice',
          amount: result.amount, currency: result.currency, renewal_date: '',
          due_date: result.due_date, status: 'invoice_received', source: base.source,
          message_id: email.messageId, updated: today,
        },
      });
      actions.push(task(`Check invoice: ${result.vendor} ${result.amount} ${result.currency} (due ${result.due_date})`,
        taskDueDate(result.due_date, r.invoiceTaskLeadDays, today)));
      break;
    case 'outage':
    case 'security':
      actions.push({
        type: 'sheet', tab: 'Incidents', ...base,
        row: {
          kind: route, provider: result.vendor ?? '', service: result.service ?? '',
          ticket: result.ticket_number ?? '', started: result.incident_start ?? '',
          urgency: result.urgency, summary: result.summary, source: base.source,
          message_id: email.messageId, logged: now.toISOString(),
        },
      });
      actions.push({
        type: 'alert', ...base,
        alert: {
          level: result.urgency === 'critical' || route === 'security' ? 'URGENT' : 'NOTICE',
          title: `${route === 'security' ? 'Security alert' : 'Outage'}: ${result.vendor ?? result.service ?? 'unknown'}`,
          text: `${result.summary}\nNext step: ${result.suggested_action}\nSource: ${base.source}`,
        },
      });
      actions.push(task(`${route === 'security' ? 'Investigate security alert' : 'Follow up outage'}: ${result.service ?? result.vendor}`,
        today, route === 'security' ? 'p1' : priority === 'p3' ? 'p2' : priority));
      break;
    case 'access':
      actions.push(task(`Access request: ${result.service}`, today));
      actions.push({
        type: 'draft', ...base,
        draft: {
          to: email.from,
          subject: `Re: ${email.subject}`,
          body: 'Hi,\n\nThanks for your request. I have logged it and will confirm once access is set up.\n\nIT',
        },
      });
      break;
    case 'log_only':
    default:
      break;
  }
  return { route, actions };
}

export function planReview(email, reasons, aiResult, { config, now }) {
  const today = now.toISOString().slice(0, 10);
  const source = sourceLink(email);
  return {
    route: 'review',
    actions: [
      {
        type: 'sheet', tab: 'ReviewQueue', messageId: email.messageId, source,
        row: {
          received: email.date, from: email.from, subject: email.subject,
          ai_category: aiResult?.category ?? '', ai_confidence: aiResult?.confidence ?? '',
          ai_summary: aiResult?.summary ?? '', reasons: reasons.join(' | '),
          status: 'open', source, message_id: email.messageId, logged: today,
        },
      },
      {
        type: 'todoist', messageId: email.messageId, source,
        task: {
          project: config.routing.todoistProject,
          content: `Review AI triage: ${email.subject}`,
          description: `Reasons: ${reasons.join('; ')}\nSource: ${source}`,
          due_date: today, priority: 'p2', labels: ['ai-triage', 'review'],
        },
      },
    ],
  };
}
