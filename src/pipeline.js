// Scenario S1 "Intake & AI triage" as code: the reference implementation the
// Make scenario follows step by step (see make/BUILD_GUIDE.md), and the engine
// the simulator and tests run.
//
// deps = {
//   config, prompt, schema,
//   callClaude(body) -> Messages API response   (live SDK or mock)
//   sinks: { sheet(tab,row), todoist(task), alert(alert), draft(draft),
//            email(alert)  [fallback alert channel],
//            deadLetter(entry) -> id, updateDeadLetter(id, patch), runLog(entry) },
//   store: MemoryStore, now(): Date, sleep(ms)
// }
import { buildEmailBlock } from './clean.js';
import { buildRequest, extractResult } from './claude.js';
import { validateResult } from './validate.js';
import { planActions, planReview } from './router.js';
import { withRetry, nextStepFor } from './retry.js';
import { formatFailureAlert } from './alerts.js';
import { actionKey } from './store.js';

const SCENARIO = 'S1 Intake';

export function createPipeline(deps) {
  const { config, prompt, schema, callClaude, sinks, store } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep;

  async function execute(action) {
    switch (action.type) {
      case 'sheet': return sinks.sheet(action.tab, action.row);
      case 'todoist': return sinks.todoist(action.task);
      case 'alert': return sinks.alert(action.alert);
      case 'draft': return sinks.draft(action.draft);
      default: throw new Error(`unknown action type ${action.type}`);
    }
  }

  async function sendFailureAlert(text) {
    const alert = { level: 'ALERT', title: 'IT Ops Automation failure', text };
    try {
      await withRetry(() => sinks.alert(alert), config.retry, { sleep });
      return 'alert';
    } catch {
      // Primary channel down: fall back to email so the failure is never silent.
      try {
        await sinks.email(alert);
        return 'email';
      } catch {
        return 'none';
      }
    }
  }

  async function fail(email, stage, err, ctx) {
    const entry = {
      time: now().toISOString(),
      scenario: SCENARIO,
      stage,
      error_status: err.status ?? err.code ?? '',
      error_message: err.message,
      classification: err.classification ?? 'permanent',
      attempts: err.attempts ?? 1,
      message_id: email.messageId,
      subject: email.subject,
      status: 'open',
      payload: email,
      payload_json: JSON.stringify(email), // S5 replays from this column
    };
    const id = await sinks.deadLetter(entry);
    const text = formatFailureAlert({
      scenario: SCENARIO, stage, err, email, attempts: entry.attempts,
      deadLetterId: id, nextStep: nextStepFor(err),
    });
    const alertedVia = await sendFailureAlert(text);
    await sinks.runLog({
      time: entry.time, message_id: email.messageId, subject: email.subject,
      category: ctx.category ?? '', confidence: ctx.confidence ?? '', route: ctx.route ?? '',
      outcome: 'failed', retries: ctx.retries, duration_ms: now() - ctx.t0, detail: `${stage}: ${err.message}`,
    });
    return { outcome: 'dead_letter', stage, deadLetterId: id, alertedVia, retries: ctx.retries, alertText: text };
  }

  async function processItem(email) {
    const t0 = now();
    const ctx = { t0, retries: 0 };
    const onRetry = () => { ctx.retries += 1; };

    // Watchdog canary: proves the trigger and scenario are alive, skips the AI call.
    if (email.canary) {
      store.set('canarySeenAt', t0.toISOString());
      await sinks.runLog({ time: t0.toISOString(), message_id: email.messageId, subject: email.subject, outcome: 'heartbeat', retries: 0, duration_ms: 0 });
      return { outcome: 'heartbeat' };
    }

    if (store.isProcessed(email.messageId)) {
      await sinks.runLog({ time: t0.toISOString(), message_id: email.messageId, subject: email.subject, outcome: 'duplicate', retries: 0, duration_ms: 0 });
      return { outcome: 'duplicate' };
    }

    const block = buildEmailBlock(email, config.ai.maxEmailChars);
    const body = buildRequest(block.text, { config, prompt, schema });

    // 1. Ask Claude. Temporary API errors are retried; unreadable output gets
    //    one more try, then goes to review.
    let ai;
    let invalidRetries = 0;
    for (;;) {
      let response;
      try {
        ({ value: response } = await withRetry(() => callClaude(body), config.retry, { sleep, onRetry }));
      } catch (err) {
        return fail(email, 'claude', err, ctx);
      }
      ai = extractResult(response);
      const retryable = !ai.ok && (ai.kind === 'invalid_json' || ai.kind === 'empty');
      if (!retryable || invalidRetries >= config.retry.invalidAiOutputRetries) break;
      invalidRetries += 1;
      ctx.retries += 1;
    }

    // 2. Check the answer, 3. plan the actions.
    let plan;
    let reasons = [];
    if (!ai.ok) {
      reasons = [`ai_output ${ai.kind}: ${ai.detail}`];
      plan = planReview(email, reasons, null, { config, now: t0 });
    } else {
      const check = validateResult(ai.data, { email, cleanText: block.body, schema, config });
      reasons = check.reasons;
      plan = check.decision === 'accept'
        ? planActions(ai.data, email, { config, now: t0 })
        : planReview(email, reasons, ai.data, { config, now: t0 });
      ctx.category = ai.data.category;
      ctx.confidence = ai.data.confidence;
    }
    ctx.route = plan.route;

    // 4. Execute. Each finished action is recorded, so a replay skips it.
    for (const [i, action] of plan.actions.entries()) {
      const key = actionKey(email.messageId, action, i);
      if (store.isActionDone(key)) continue;
      try {
        await withRetry(() => execute(action), config.retry, { sleep, onRetry });
        store.markActionDone(key);
      } catch (err) {
        return fail(email, `action:${action.type}${action.tab ? `:${action.tab}` : ''}`, err, ctx);
      }
    }

    store.markProcessed(email.messageId, now().toISOString());
    const outcome = plan.route === 'review' ? 'review' : 'routed';
    await sinks.runLog({
      time: t0.toISOString(), message_id: email.messageId, subject: email.subject,
      category: ctx.category ?? '', confidence: ctx.confidence ?? '', route: plan.route,
      outcome, retries: ctx.retries, duration_ms: now() - t0, detail: reasons.join(' | '),
    });
    return { outcome, route: plan.route, category: ctx.category, reasons, retries: ctx.retries, actions: plan.actions };
  }

  /** S5: re-run a dead-lettered item after its root cause is fixed. */
  async function replay(deadLetterId, entry) {
    const result = await processItem(entry.payload);
    if (result.outcome === 'routed' || result.outcome === 'review' || result.outcome === 'duplicate') {
      await sinks.updateDeadLetter(deadLetterId, { status: 'replayed', replayed_at: now().toISOString() });
    }
    return result;
  }

  return { processItem, replay };
}
