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
