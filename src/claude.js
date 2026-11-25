// Builds the Claude request and reads the reply.
// The request body is the same one Make sends from its HTTP module
// (make/http/anthropic-request.json); tests/claude.test.js keeps the two in step.

export const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Request body for POST /v1/messages.
 * - Structured outputs (output_config.format) make the reply valid JSON for the schema.
 * - effort "low": triage is a short classification task.
 * - fallbacks "default": if the model declines for a safety reason, the API
 *   re-runs the request on a fallback model in the same call (beta header needed).
 */
export function buildRequest(emailText, { config, prompt, schema }) {
  return {
    model: config.ai.model,
    max_tokens: config.ai.maxTokens,
    output_config: {
      effort: config.ai.effort,
      format: { type: 'json_schema', schema },
    },
    fallbacks: 'default',
    system: prompt,
    messages: [{ role: 'user', content: emailText }],
  };
}

export function requestHeaders(config, apiKeyPlaceholder = '{{ANTHROPIC_API_KEY}}') {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKeyPlaceholder,
    'anthropic-version': config.ai.anthropicVersion,
    'anthropic-beta': config.ai.fallbackBeta,
  };
}

/**
 * Read a Messages API response.
 * Returns { ok: true, data } or { ok: false, kind, detail }, where kind is
 * 'refusal' | 'truncated' | 'invalid_json' | 'empty'.
 */
export function extractResult(response) {
  if (!response || typeof response !== 'object') return { ok: false, kind: 'empty', detail: 'no response body' };
  if (response.stop_reason === 'refusal') {
    const cat = response.stop_details?.category ?? 'unspecified';
    return { ok: false, kind: 'refusal', detail: `model declined (category: ${cat})` };
  }
  if (response.stop_reason === 'max_tokens') {
    return { ok: false, kind: 'truncated', detail: 'reply cut off at max_tokens' };
  }
  const text = (response.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) return { ok: false, kind: 'empty', detail: 'no text block in reply' };
  try {
    return { ok: true, data: JSON.parse(text), model: response.model, usage: response.usage };
  } catch (err) {
    return { ok: false, kind: 'invalid_json', detail: `could not parse JSON: ${err.message}` };
  }
}

/**
 * Live caller using the official SDK. Loaded lazily so the offline tests and
 * the simulator run without the package or an API key.
 * SDK retries are turned off: the pipeline's own retry policy decides, so the
 * behaviour matches the Make scenario.
 */
export async function createLiveCaller(config) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 0, timeout: 60_000 });
  return async function callClaude(body) {
    try {
      return await client.beta.messages.create({ ...body, betas: [config.ai.fallbackBeta] });
    } catch (err) {
      // Normalise SDK errors to the shape the retry policy reads.
      const e = new Error(err.message);
      e.status = err.status;
      e.code = err.status ? undefined : (err.code ?? err.cause?.code ?? 'ECONNRESET');
      throw e;
    }
  };
}
