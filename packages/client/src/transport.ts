/**
 * The one place an HTTP request to TokenShield is made.
 *
 * Every surface goes through `Transport.send`, so every call is recorded the
 * same way: full request, full response, all headers, TTFB and total latency,
 * the gateway's own signal headers, and a named verdict. Nothing bypasses it —
 * that is what makes a Playground call, a scenario step and a vendor-SDK call
 * directly comparable.
 */

import { classify } from './classify.js';
import { maskSecret, redactHeaders, scrubText } from './redact.js';
import { parseGatewaySignal } from './signal.js';
import type {
  AuthScheme,
  Exchange,
  ExchangeMode,
  ExchangeRequest,
  ExchangeResponse,
  Profile,
} from './types.js';

export const LAB_USER_AGENT = 'tokenshield-lab/0.1.0';

export interface TransportInit {
  profile: Profile;
  /** Display name for the credential. The raw value never leaves this object. */
  keyAlias?: string | null;
  secret?: string | null;
  /** Default presentation for the credential. Overridable per request. */
  scheme?: AuthScheme;
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable for tests and for the vendor-SDK adapters in Phase 4. */
  fetchImpl?: typeof fetch;
}

export interface SendRequest {
  /** Short name for the UI: 'models', 'chat.completions', 'health', … */
  surface: string;
  method: string;
  /** Path from the gateway root, e.g. '/v1/models'. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Override the default auth presentation for this one call. */
  auth?: AuthScheme;
  /** Override the credential (e.g. a management key for the Keys page). */
  secret?: string | null;
  timeoutMs?: number;
  accept?: string;
  mode?: ExchangeMode;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function buildQuery(query: SendRequest['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Node's fetch reports every network failure as a bare `TypeError: fetch
 * failed` and hides the real reason in `error.cause`. Unwrapping the chain is
 * the difference between "something went wrong" and "nothing is listening on
 * :4000" — which is the single most common thing to go wrong here.
 */
function describeTransportError(error: unknown, url: string): string {
  if (!(error instanceof Error)) return String(error);

  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let code: string | undefined;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const currentCode = (current as { code?: unknown }).code;
    if (typeof currentCode === 'string' && code === undefined) code = currentCode;
    // Undici's inner cause often carries a code with an empty message.
    const line =
      typeof currentCode === 'string'
        ? current.message.length > 0
          ? `${currentCode}: ${current.message}`
          : currentCode
        : current.message;
    if (line.length > 0 && !chain.includes(line)) chain.push(line);
    current = (current as { cause?: unknown }).cause;
  }

  let hint = '';
  if (code === 'ECONNREFUSED') hint = ` — nothing is listening at ${new URL(url).origin}`;
  else if (code === 'ENOTFOUND') hint = ' — host does not resolve; check the profile base URL';
  else if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    hint = ' — TLS certificate could not be verified';
  }

  return `${chain.join(' → ')}${hint}`;
}

/** Parses when it can, keeps the text either way — a malformed body is a finding. */
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export class Transport {
  private readonly profile: Profile;
  private readonly keyAlias: string | null;
  private readonly secret: string | null;
  private readonly scheme: AuthScheme;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(init: TransportInit) {
    this.profile = init.profile;
    this.keyAlias = init.keyAlias ?? null;
    this.secret = init.secret ?? null;
    this.scheme = init.scheme ?? (this.secret !== null ? 'bearer' : 'none');
    this.timeoutMs = init.timeoutMs ?? 60_000;
    this.userAgent = init.userAgent ?? LAB_USER_AGENT;
    this.fetchImpl = init.fetchImpl ?? globalThis.fetch;
  }

  get activeProfile(): Profile {
    return this.profile;
  }

  /** The alias selected for this client, whether or not a given call uses it. */
  get selectedKeyAlias(): string | null {
    return this.keyAlias;
  }

  /** `cg-ak-abcd…wxyz`, safe to show anywhere. */
  get maskedSecret(): string {
    return maskSecret(this.secret);
  }

  private authHeaderFor(scheme: AuthScheme, secret: string | null): Record<string, string> {
    if (scheme === 'none' || secret === null || secret.length === 0) return {};
    switch (scheme) {
      case 'bearer':
        return { Authorization: `Bearer ${secret}` };
      case 'x-api-key':
        return { 'x-api-key': secret };
      case 'x-management-key':
        return { 'x-management-key': secret };
      case 'x-admin-key':
        return { 'x-admin-key': secret };
      default:
        return {};
    }
  }

  async send(req: SendRequest): Promise<Exchange> {
    const scheme = req.auth ?? this.scheme;
    const secret = req.secret !== undefined ? req.secret : this.secret;
    const url = `${joinUrl(this.profile.baseUrl, req.path)}${buildQuery(req.query)}`;
    const hasBody = req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD';
    const bodyText = hasBody ? JSON.stringify(req.body) : undefined;

    const outgoing: Record<string, string> = {
      Accept: req.accept ?? 'application/json',
      'User-Agent': this.userAgent,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...this.authHeaderFor(scheme, secret),
      ...(req.headers ?? {}),
    };

    // A credential was only actually presented if a scheme carried it. The
    // unauthenticated probes (/health, HEAD /, metrics) run on the same client
    // as the authenticated ones, and logging them as "used key X" would be a
    // lie the exchange log then repeats.
    const credentialSent = scheme !== 'none' && secret !== null && secret.length > 0;

    const recordedRequest: ExchangeRequest = {
      method: req.method,
      url,
      path: req.path,
      headers: redactHeaders(outgoing),
    };
    if (req.body !== undefined) recordedRequest.body = req.body;
    if (bodyText !== undefined) recordedRequest.bodyText = bodyText;

    const startedAt = nowIso();
    const t0 = performance.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const base = {
      id: newId(),
      profileId: this.profile.id,
      profileLabel: this.profile.label,
      baseUrl: this.profile.baseUrl,
      keyAlias: credentialSent ? this.keyAlias : null,
      authScheme: scheme,
      surface: req.surface,
      mode: req.mode ?? ('raw' as ExchangeMode),
      request: recordedRequest,
    };

    try {
      const res = await this.fetchImpl(url, {
        method: req.method,
        headers: outgoing,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      const ttfbMs = performance.now() - t0;

      const rawText = req.method === 'HEAD' ? '' : await res.text();
      const totalMs = performance.now() - t0;
      const text = secret !== null ? scrubText(rawText, [secret]) : rawText;
      const headers = headersToObject(res.headers);
      const parsed = tryParseJson(text);

      const response: ExchangeResponse = {
        status: res.status,
        statusText: res.statusText,
        headers,
      };
      if (parsed !== undefined) response.body = parsed;
      if (text.length > 0) response.bodyText = text;

      const gateway = parseGatewaySignal(headers);
      const verdict = classify({ status: res.status, headers, body: parsed });

      const timings = {
        startedAt,
        ttfbMs: Math.round(ttfbMs * 100) / 100,
        totalMs: Math.round(totalMs * 100) / 100,
        ...(gateway.guardrailMs !== undefined ? { guardrailMs: gateway.guardrailMs } : {}),
      };

      return { ...base, response, timings, gateway, verdict };
    } catch (error) {
      const totalMs = performance.now() - t0;
      const aborted = controller.signal.aborted;
      const message = aborted
        ? `Timed out after ${timeoutMs}ms`
        : describeTransportError(error, url);

      return {
        ...base,
        timings: { startedAt, ttfbMs: 0, totalMs: Math.round(totalMs * 100) / 100 },
        gateway: {},
        verdict: classify({ status: 0, headers: {}, body: undefined, transportError: message }),
        transportError: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
