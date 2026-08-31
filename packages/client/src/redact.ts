/**
 * Secret hygiene.
 *
 * A raw `cg-ak-` / `cg-mk-` value must never leave the backend's memory: not
 * into an Exchange, not into a log line, not into an exported report, and never
 * into the browser. Every path out goes through here.
 *
 * The sibling Python suite keeps ~14 live keys in plaintext in a committed
 * RUNBOOK. This repo does not repeat that.
 */

/** Headers whose value is a credential. Compared case-insensitively. */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-management-key',
  'x-admin-key',
  'x-goog-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/** Any header starting with this prefix carries a per-server MCP credential. */
const SECRET_HEADER_PREFIX = 'x-mcp-';

/**
 * `cg-ak-abcd…wxyz` — enough to recognise which key was used, not enough to
 * use it. Short values collapse entirely rather than leaking a usable fragment.
 */
export function maskSecret(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw).trim();
  if (s.length === 0) return '';
  if (s.length <= 12) return '*'.repeat(s.length);
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}

/** Masks the credential inside an `Authorization: Bearer <secret>` value. */
function maskHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (!isSecretHeader(lower)) return value;

  const bearer = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value);
  if (bearer && bearer[1] !== undefined && bearer[2] !== undefined) {
    return `${bearer[1]} ${maskSecret(bearer[2])}`;
  }
  return maskSecret(value);
}

export function isSecretHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_HEADERS.has(lower) || lower.startsWith(SECRET_HEADER_PREFIX);
}

/** Returns a copy with every credential header masked. Never mutates input. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = maskHeaderValue(name, value ?? '');
  }
  return out;
}

/**
 * Keys whose **string** values are credentials wherever they appear in a
 * request body.
 *
 * This exists because of MCP. OpenAI's `type: 'mcp'` tool block carries a
 * `headers` object aimed at a third-party server — client-supplied credential
 * material sitting in the request *body*, where `redactHeaders` never looks.
 * Before this, such a value was recorded verbatim and then shown in the
 * exchange log, in `copy as curl`, and in exported reports.
 */
const SECRET_BODY_KEYS = new Set([
  'authorization',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'bearer_token',
  'private_key',
  'token',
]);

/**
 * Mask a credential found in a request **body**.
 *
 * Deliberately harsher than `maskSecret`. That one preserves the first ten
 * characters so you can tell *which* gateway key was used, which is safe only
 * because `cg-ak-`/`cg-mk-` keys carry a public prefix there. An arbitrary
 * third-party credential has no such prefix, so keeping ten characters of it is
 * simply disclosure — a 14-character password came out as `hunter2hun…ter2`,
 * which is the whole thing. Found by the test below, not by inspection.
 *
 * So: reveal nothing of the secret. The auth scheme word is kept, because
 * `Bearer` vs `Basic` is a real debugging signal and is not itself secret. The
 * asterisk run is a **fixed** width rather than the value's length, so a short
 * credential does not disclose how short it is — and it makes the invariant one
 * sentence: a masked body credential is always `[scheme ]************`.
 * Identifying the gateway key is not lost — the exchange records `keyAlias`
 * separately.
 */
function maskBodySecret(raw: string): string {
  const s = raw.trim();
  if (s.length === 0) return '';
  const scheme = /^(Bearer|Basic|Token|ApiKey)\s+(.*)$/i.exec(s);
  const rest = scheme?.[2] ?? s;
  const prefix = scheme?.[1] !== undefined ? `${scheme[1]} ` : '';
  return rest.length === 0 ? prefix.trim() : `${prefix}${'*'.repeat(12)}`;
}

/** True for a body key whose string value should never be recorded. */
export function isSecretBodyKey(name: string): boolean {
  const lower = name.toLowerCase();
  return isSecretHeader(lower) || SECRET_BODY_KEYS.has(lower);
}

/**
 * Returns a deep copy of a request body with credential-bearing values masked.
 * Never mutates the input — the body that goes on the wire must stay intact, or
 * the lab would be testing a request it did not send.
 *
 * Only **string** values are masked. A JSON Schema can legitimately have a
 * property named `token`, and its value there is an object describing a field
 * rather than a credential; masking it would corrupt the recorded schema for no
 * safety gain. So an object under a secret-looking key is recursed into, not
 * flattened. The residual over-redaction — a string example value under a key
 * called `token` — is the right way to be wrong.
 */
export function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactBody(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = typeof v === 'string' && isSecretBodyKey(key) ? maskBodySecret(v) : redactBody(v);
    }
    return out;
  }
  return value;
}

/**
 * Last line of defence: strips any known secret that leaked into free text
 * (an echoed request body, a provider error quoting the header, a stack trace).
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join(maskSecret(secret));
  }
  return out;
}
