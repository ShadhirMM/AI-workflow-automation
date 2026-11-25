// Turns a raw email into the text block that is sent to Claude.
// Mirrors the "Text parser > HTML to text" + "Set variable" steps in Make scenario S1.

const QUOTE_HEADER = /^On .{3,200} wrote:\s*$/m;
const SIGNATURE = /^-- ?$/m;
const FORWARD_MARKER = /-{5,}\s*Forwarded message\s*-{5,}/i;

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Strip quoted replies and signatures, keep forwarded content, collapse whitespace. */
export function cleanBody(body, { isHtml = false } = {}) {
  let text = isHtml ? htmlToText(body) : String(body ?? '');
  text = text.replace(/\r\n/g, '\n');

  // A forwarded email is the useful part, so only cut quoted replies when the
  // reply header comes before any forward marker.
  const fwd = text.search(FORWARD_MARKER);
  const quote = text.search(QUOTE_HEADER);
  if (quote !== -1 && (fwd === -1 || quote < fwd)) text = text.slice(0, quote);

  // Cut the signature, unless it sits above a forwarded block (then the
  // forwarded content below it is what matters).
  const sig = text.search(SIGNATURE);
  if (sig !== -1 && (fwd === -1 || sig > fwd)) text = text.slice(0, sig);

  text = text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/** Wrap the email in <email> tags with its headers, capped to maxChars. */
export function buildEmailBlock(email, maxChars = 8000) {
  let body = cleanBody(email.body, { isHtml: Boolean(email.isHtml) });
  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }
  const headers = [
    `From: ${email.from ?? ''}`,
    `To: ${email.to ?? ''}`,
    `Date: ${email.date ?? ''}`,
    `Subject: ${email.subject ?? ''}`,
  ].join('\n');
  const note = truncated ? `\n[Body truncated to ${maxChars} characters]` : '';
  return { text: `<email>\n${headers}\n\n${body}${note}\n</email>`, body, truncated };
}

export function senderDomain(from) {
  const m = String(from ?? '').match(/@([A-Za-z0-9.-]+)>?\s*$/);
  return m ? m[1].toLowerCase() : null;
}
