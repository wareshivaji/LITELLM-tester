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
import { SSEParser } from './sse.js';
import type {
  AuthScheme,
  Exchange,
  ExchangeMode,
  ExchangeRequest,
  ExchangeResponse,
  GatewaySignal,
  Profile,
  StreamChunk,
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

export interface StreamRequest extends SendRequest {
  /** Called as each frame arrives, so a caller can relay it live. */
  onChunk?: (chunk: StreamChunk) => void;
  /** Aborts the stream — the console's Stop button. */
  signal?: AbortSignal;
}

function nowIso(): string {
  return new Date().toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Frames are model output, so a credential should never appear in one — but
 * "should never" is not "cannot", and a frame echoing the request would put a
 * live key into the exchange log and every export of it.
 */
function scrubChunk(chunk: StreamChunk, secret: string): StreamChunk {
  if (!chunk.raw.includes(secret)) return chunk;
  const raw = scrubText(chunk.raw, [secret]);
  const next: StreamChunk = { ...chunk, raw };
  try {
    next.parsed = JSON.parse(raw);
  } catch {
    delete next.parsed;
  }
  return next;
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

  /**
   * Everything both `send` and `stream` need to do before the fetch. Shared so
   * a streaming call and a buffered one cannot drift in how they authenticate,
   * what they record, or how they redact.
   */
  private prepare(req: SendRequest, accept: string) {
    const scheme = req.auth ?? this.scheme;
    const secret = req.secret !== undefined ? req.secret : this.secret;
    const url = `${joinUrl(this.profile.baseUrl, req.path)}${buildQuery(req.query)}`;
    const hasBody = req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD';
    const bodyText = hasBody ? JSON.stringify(req.body) : undefined;

    const outgoing: Record<string, string> = {
      Accept: req.accept ?? accept,
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

    return { scheme, secret, url, bodyText, outgoing, base };
  }

  async send(req: SendRequest): Promise<Exchange> {
    const { secret, url, bodyText, outgoing, base } = this.prepare(req, 'application/json');

    const startedAt = nowIso();
    const t0 = performance.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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

  /**
   * Same call, read as a stream.
   *
   * Frames are surfaced to `onChunk` as they arrive *and* accumulated into the
   * returned Exchange, so the console can render live while the record stays
   * complete and replayable.
   *
   * The timeout is a whole-stream budget rather than per-read: a stream that
   * stalls forever after one token is a failure worth catching, and there is no
   * safe way to distinguish "the model is thinking" from "the connection is
   * dead" from the client side.
   *
   * An error response is not SSE — the gateway rejects with a JSON body — so a
   * non-2xx falls back to buffered reading and classifies exactly as `send`
   * would.
   */
  async stream(req: StreamRequest): Promise<Exchange> {
    const { secret, url, bodyText, outgoing, base } = this.prepare(req, 'text/event-stream');

    const startedAt = nowIso();
    const t0 = performance.now();
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A caller-supplied signal (the Stop button) aborts the same fetch.
    const onExternalAbort = (): void => controller.abort();
    req.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const chunks: StreamChunk[] = [];
    // Captured as soon as headers arrive, so an abort or a mid-stream failure
    // still reports the gateway's X-Request-ID — which is the only handle on
    // "did that aborted stream get billed?".
    let capturedHeaders: Record<string, string> = {};
    let capturedGateway: GatewaySignal = {};

    try {
      const res = await this.fetchImpl(url, {
        method: req.method,
        headers: outgoing,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      const ttfbMs = performance.now() - t0;
      const headers = headersToObject(res.headers);
      const gateway = parseGatewaySignal(headers);
      capturedHeaders = headers;
      capturedGateway = gateway;

      // Not every answer to a streaming request is a stream. A rejection comes
      // back as ordinary JSON, and so does a request the gateway decided not to
      // stream (`stream: false`, or a surface that ignores the flag). Reading
      // either one with an SSE parser finds no `data:` field and throws the
      // whole body away, so switch on what actually arrived rather than on what
      // was asked for.
      const isEventStream = (headers['content-type'] ?? '').includes('text/event-stream');
      if (!res.ok || res.body === null || !isEventStream) {
        const rawText = res.body === null ? '' : await res.text();
        const totalMs = performance.now() - t0;
        const text = secret !== null ? scrubText(rawText, [secret]) : rawText;
        const parsed = tryParseJson(text);
        const response: ExchangeResponse = {
          status: res.status,
          statusText: res.statusText,
          headers,
        };
        if (parsed !== undefined) response.body = parsed;
        if (text.length > 0) response.bodyText = text;
        return {
          ...base,
          response,
          timings: {
            startedAt,
            ttfbMs: round2(ttfbMs),
            totalMs: round2(totalMs),
            ...(gateway.guardrailMs !== undefined ? { guardrailMs: gateway.guardrailMs } : {}),
          },
          gateway,
          verdict: classify({ status: res.status, headers, body: parsed }),
        };
      }

      const parser = new SSEParser();
      const reader = res.body.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        for (const chunk of parser.push(value, round2(performance.now() - t0))) {
          const scrubbed = secret !== null ? scrubChunk(chunk, secret) : chunk;
          chunks.push(scrubbed);
          req.onChunk?.(scrubbed);
        }
      }
      for (const chunk of parser.flush(round2(performance.now() - t0))) {
        const scrubbed = secret !== null ? scrubChunk(chunk, secret) : chunk;
        chunks.push(scrubbed);
        req.onChunk?.(scrubbed);
      }

      const totalMs = performance.now() - t0;
      const response: ExchangeResponse = {
        status: res.status,
        statusText: res.statusText,
        headers,
        chunks,
      };

      return {
        ...base,
        response,
        timings: {
          startedAt,
          ttfbMs: round2(ttfbMs),
          totalMs: round2(totalMs),
          ...(gateway.guardrailMs !== undefined ? { guardrailMs: gateway.guardrailMs } : {}),
        },
        gateway,
        verdict: classify({ status: res.status, headers, body: undefined }),
      };
    } catch (error) {
      const totalMs = performance.now() - t0;
      const externallyAborted = req.signal?.aborted === true;
      const message = externallyAborted
        ? `Stopped by the client after ${round2(totalMs)}ms and ${chunks.length} frame(s)`
        : controller.signal.aborted
          ? `Timed out after ${timeoutMs}ms`
          : describeTransportError(error, url);

      // Whatever arrived before the break is kept — a partial stream is the
      // whole point of an abort test — along with the response headers, so the
      // request id survives to answer the billing question later.
      const response: ExchangeResponse | undefined =
        chunks.length > 0 || Object.keys(capturedHeaders).length > 0
          ? { status: 0, statusText: 'incomplete', headers: capturedHeaders, chunks }
          : undefined;

      return {
        ...base,
        ...(response !== undefined ? { response } : {}),
        timings: { startedAt, ttfbMs: 0, totalMs: round2(totalMs) },
        gateway: capturedGateway,
        verdict: classify({ status: 0, headers: {}, body: undefined, transportError: message }),
        transportError: message,
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
