// Offline stand-ins for Claude and the outside systems (Google Sheets, Todoist,
// Slack/Telegram, Gmail). Used by the simulator and the tests so the whole flow,
// including failures, can be exercised without accounts or API keys.
//
// The mock Claude returns scripted answers from tests/fixtures/emails.json.
// It tests the plumbing (validation, routing, retries, dead letters), NOT the
// quality of the AI. tools/eval-prompt.js measures the real model.

function makeError({ status, code, message }) {
  const e = new Error(message ?? `mock error ${status ?? code}`);
  if (status) e.status = status;
  if (code) e.code = code;
  return e;
}

function responseFor(step, model) {
  if (step.stop_reason === 'refusal') {
    return { type: 'message', model, content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'mock refusal' } };
  }
  const text = step.raw ?? JSON.stringify(step.output);
  return {
    type: 'message', model, stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 900, output_tokens: 180 },
  };
}

/** callClaude(body) that answers from each fixture's mock script, matched by subject. */
export function createMockClaude(fixtures, model = 'mock-claude') {
  const bySubject = new Map();
  for (const f of fixtures) {
    if (!bySubject.has(f.email.subject)) bySubject.set(f.email.subject, f);
  }
  const calls = new Map();
  const log = [];
  async function callClaude(body) {
    const content = body.messages[0].content;
    const subject = content.match(/^Subject: (.*)$/m)?.[1];
    const fixture = bySubject.get(subject);
    if (!fixture) throw makeError({ status: 400, message: `mock: no fixture for subject "${subject}"` });
    const steps = fixture.mock.sequence ?? [{ output: fixture.mock.output }];
    const n = calls.get(fixture.id) ?? 0;
    calls.set(fixture.id, n + 1);
    const step = steps[Math.min(n, steps.length - 1)];
    log.push({ fixture: fixture.id, call: n + 1, step: Object.keys(step)[0] });
    if (step.error) throw makeError(step.error);
    return responseFor(step, model);
  }
  return { callClaude, calls, log };
}

/** In-memory sinks with optional fault injection, plus CSV export. */
export function createMemorySinks() {
  const state = {
    sheets: { Subscriptions: [], Incidents: [], ReviewQueue: [], DeadLetter: [], RunLog: [] },
    tasks: [], alerts: [], emails: [], drafts: [],
  };
  let faults = {};

  function maybeFail(name) {
    const queue = faults[name];
    if (queue && queue.length) throw makeError(queue.shift());
  }

  const sinks = {
    async sheet(tab, row) { maybeFail('sheet'); state.sheets[tab].push({ ...row }); },
    async todoist(task) { maybeFail('todoist'); state.tasks.push({ id: `T${state.tasks.length + 1}`, ...task }); },
    async alert(alert) { maybeFail('alert'); state.alerts.push({ ...alert }); },
    async email(alert) { maybeFail('email'); state.emails.push({ ...alert }); },
    async draft(draft) { maybeFail('draft'); state.drafts.push({ ...draft }); },
    async deadLetter(entry) {
      const id = `DL${String(state.sheets.DeadLetter.length + 1).padStart(3, '0')}`;
      state.sheets.DeadLetter.push({ id, ...entry });
      return id;
    },
    async updateDeadLetter(id, patch) {
      const row = state.sheets.DeadLetter.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    },
    async runLog(entry) { state.sheets.RunLog.push({ ...entry }); },
  };

  return {
    sinks,
    state,
    /** faults = { todoist: [{status: 404}], alert: [...] } — each entry fails one call. */
    setFaults(f) { faults = structuredClone(f ?? {}); },
  };
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
