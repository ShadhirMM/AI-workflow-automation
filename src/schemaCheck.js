// Small JSON-schema checker for the subset used by prompts/triage.schema.json:
// type, enum, anyOf, required, properties, additionalProperties:false, format date / date-time.
// Structured outputs already guarantee the shape; this is the second, independent check
// ("check and test every output").

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

export function checkSchema(value, schema, path = '$') {
  const errors = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => checkSchema(value, s, path).length === 0);
    if (!ok) errors.push(`${path}: does not match any allowed type`);
    return errors;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: "${value}" is not one of ${schema.enum.join(', ')}`);
  }
  if (schema.format === 'date' && !isRealDate(value)) errors.push(`${path}: not a real YYYY-MM-DD date`);
  if (schema.format === 'date-time' && (!DATETIME_RE.test(value) || Number.isNaN(Date.parse(value)))) {
    errors.push(`${path}: not an ISO 8601 date-time with offset`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: missing`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        continue;
      }
      errors.push(...checkSchema(v, sub, `${path}.${key}`));
    }
  }
  return errors;
}
