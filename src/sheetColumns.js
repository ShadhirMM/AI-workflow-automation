// Column order for each tab of the "IT Ops Automation — DEMO" Google Sheet.
// Used for CSV export, the sheet template and the Make "Add a row" mappings.
export const COLUMNS = {
  Subscriptions: ['vendor', 'service', 'kind', 'amount', 'currency', 'renewal_date', 'due_date', 'status', 'source', 'message_id', 'updated'],
  Incidents: ['kind', 'provider', 'service', 'ticket', 'started', 'urgency', 'summary', 'source', 'message_id', 'logged'],
  ReviewQueue: ['received', 'from', 'subject', 'ai_category', 'ai_confidence', 'ai_summary', 'reasons', 'status', 'reviewer', 'decision', 'source', 'message_id', 'logged'],
  DeadLetter: ['id', 'time', 'scenario', 'stage', 'error_status', 'error_message', 'classification', 'attempts', 'message_id', 'subject', 'status', 'replayed_at', 'payload_json'],
  RunLog: ['time', 'message_id', 'subject', 'category', 'confidence', 'route', 'outcome', 'retries', 'duration_ms', 'detail'],
  Config: ['key', 'value', 'notes'],
};
