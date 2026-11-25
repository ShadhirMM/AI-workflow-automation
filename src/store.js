// Idempotency store. In Make this is the Data Store "processed_ids".
// - processed: message IDs that finished successfully (dedupe).
// - doneActions: action keys already executed for an item, so a replay after a
//   partial failure does not write the same sheet row or task twice.
// - heartbeat: last canary seen (for the watchdog).

export class MemoryStore {
  constructor() {
    this.processed = new Map();
    this.doneActions = new Set();
    this.meta = new Map();
  }
  isProcessed(id) { return this.processed.has(id); }
  markProcessed(id, at) { this.processed.set(id, at); }
  isActionDone(key) { return this.doneActions.has(key); }
  markActionDone(key) { this.doneActions.add(key); }
  get(key) { return this.meta.get(key); }
  set(key, value) { this.meta.set(key, value); }
}

export function actionKey(messageId, action, index) {
  return `${messageId}:${index}:${action.type}${action.tab ? `:${action.tab}` : ''}`;
}
