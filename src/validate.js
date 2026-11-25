// Checks Claude's answer before anything acts on it.
// Any failed check sends the item to the human review queue instead of an action.
import { checkSchema } from './schemaCheck.js';
import { senderDomain } from './clean.js';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Western digits, '.' decimals, no thousands separators. */
export function normaliseNumbers(text) {
  return String(text)
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/(\d),(?=\d{3}\b)/g, '$1');
}

/** True when the amount Claude returned is written somewhere in the email. */
export function amountAppearsInText(amount, text) {
  if (amount === null || amount === undefined) return true;
  const hay = normaliseNumbers(text);
  const candidates = new Set([amount.toFixed(2), String(amount)]);
  if (Number.isInteger(amount)) candidates.add(`${amount}.00`);
  for (const c of candidates) {
    const re = new RegExp(`(^|[^\\d.])${c.replace('.', '\\.')}(?![\\d])`);
    if (re.test(hay)) return true;
  }
  return false;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Returns { decision: 'accept' | 'review', reasons: string[] }.
 * `context` = { email, cleanText, schema, config }.
 */
export function validateResult(result, { email, cleanText, schema, config }) {
  const reasons = [];
  const v = config.validation;

  const schemaErrors = checkSchema(result, schema);
  if (schemaErrors.length) {
    return { decision: 'review', reasons: [`schema: ${schemaErrors.slice(0, 3).join('; ')}`] };
  }

  if (result.confidence < 0 || result.confidence > 1) reasons.push('confidence outside 0–1');
  else if (result.confidence < v.confidenceThreshold) {
    reasons.push(`low confidence ${result.confidence.toFixed(2)} < ${v.confidenceThreshold}`);
  }
  if (result.needs_human_review) reasons.push(`AI asked for review: ${result.review_reason ?? 'no reason given'}`);

  for (const field of v.requiredFields[result.category] ?? []) {
    if (result[field] === null || result[field] === '') reasons.push(`missing ${field} for ${result.category}`);
  }

  if (!amountAppearsInText(result.amount, `${email.subject ?? ''}\n${cleanText}`)) {
    reasons.push(`amount ${result.amount} not found in the email text`);
  }

  const emailDate = Date.parse(email.date) ? new Date(email.date).toISOString().slice(0, 10) : null;
  for (const field of ['renewal_date', 'due_date']) {
    if (!result[field] || !emailDate) continue;
    const d = daysBetween(emailDate, result[field]);
    if (d < -v.dateWindowDays.pastMax || d > v.dateWindowDays.futureMax) {
      reasons.push(`${field} ${result[field]} is outside the expected range`);
    }
  }

  if (v.senderCheckCategories.includes(result.category)) {
    const domain = senderDomain(email.from);
    const trusted = [...v.internalDomains, ...v.trustedVendorDomains];
    if (!domain || !trusted.includes(domain)) {
      reasons.push(`sender domain ${domain ?? 'unknown'} is not on the trusted list`);
    }
  }

  return { decision: reasons.length ? 'review' : 'accept', reasons };
}
