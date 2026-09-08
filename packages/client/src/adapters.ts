/**
 * The stock vendor SDKs, pointed at the gateway.
 *
 * Everything else in this package is a hand-built HTTP client, which is what
 * makes it able to send malformed requests. This module is the opposite test:
 * what happens when a **real customer's SDK** — `openai` or
 * `@anthropic-ai/sdk`, unmodified, the versions in package.json — talks to
 * TokenShield.
 *
 * Two things it reveals that raw HTTP cannot:
 *
 *  1. **What the customer's error looks like.** The gateway's flat
 *     `{"error":"string"}` envelope is not something an OpenAI SDK can parse;
 *     raw HTTP shows the body, but only the SDK shows what the developer's
 *     `catch` block actually receives.
 *  2. **Retries.** Both SDKs retry 429s and 5xxs with backoff, on their own
 *     schedule. Each attempt is a separate fetch and therefore a separate
 *     Exchange, so a single `create()` call can produce three rows — which is
 *     exactly what a customer's bill and the gateway's usage table will show.
 *
 * The mechanism is a `fetch` implementation handed to the SDK's constructor.
 * Nothing rewrites the SDK's request: seeing what it constructs is the point.
 *
 * ## What this module does NOT do, since 2026-09-08 (D-7)
 *
 * It used to record through `Transport.sendRaw`, which produced a finished
 * `Exchange` — classified, redacted, timed. That was convenient and it was the
 * single edge binding this module to `transport.ts`, and through it to
 * `classify.ts` and `signal.ts`: **1,439 lines that the Python engine also
 * owns**. Two implementations of "what does this response mean", policed by
 * comparing their output, is the mistake that cost 1,826 lines in the aborted
 * Go migration.
 *
 * So the boundary moved. This module now performs the request with plain
 * `fetch` and emits a **`ProbeAttempt`** — what was sent, what came back, and
 * how long it took, with credential headers already masked. Python turns that
 * into an `Exchange`. Verdicts and deep redaction exist once.
 *
 * The masking happens **here**, before the record leaves the process, so no
 * plaintext credential crosses the pipe to Python. D-7 budgeted a duplicated
 * ~20-line masker for this and none was needed: `redact.ts` stays in the
 * browser bundle anyway (the web's `toCurl` imports `isSecretHeader`), so the
 * probe imports the same `redactHeaders` the rest of the package uses.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { redactHeaders } from './redact.js';
import type { Exchange, ExchangeMode } from './types.js';
// `sdkModesFor` used to live here. It moved to surfaces.ts on 2026-09-08:
// the web imports it, and importing it from THIS module bound the browser
// build to the vendor SDKs in the static graph — which is what prevented
// transport.ts from ever being deletable.

/** Which client made the call. */
/**
 * Which client built the request.
 *
 * An ALIAS, not a second declaration. This and `ExchangeMode` in `types.ts`
 * were the same three-value union written out twice, which was found while
 * tracing what the web actually imports. Two independent spellings of one
 * union drift the moment a fourth mode is added to one of them.
 */
export type SdkMode = ExchangeMode;

/** How the SDK reported a failure — what a developer's catch block sees. */
export interface SdkFailure {
  /** Constructor name, e.g. `BadRequestError`, `APIConnectionError`. */
  name: string;
  status?: number;
  message: string;
  /** Parsed out of the error body by the SDK, when it managed to. */
  type?: string;
  code?: string;
  /** True when the SDK produced a typed API error rather than something generic. */
  typed: boolean;
}

export interface SdkOutcome {
  mode: SdkMode;
  ok: boolean;
  /** The SDK's own parsed result. */
  result?: unknown;
  failure?: SdkFailure;
  /** One per HTTP attempt, so retries are visible. */
  attempts: Exchange[];
  /** Extra request headers the SDK added that we would never have sent. */
  sdkHeaders: string[];
}

/** Headers we send ourselves; anything else came from the SDK. */
const OUR_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'user-agent',
  'x-api-key',
  'content-length',
  'accept-encoding',
]);

/**
 * One HTTP attempt, exactly as observed, with credentials already masked.
 *
 * Deliberately NOT an `Exchange`. An Exchange carries a verdict, a gateway
 * signal and a redacted body — all derived, and all owned by the Python engine.
 * This type is the observation: the fields nobody can compute after the fact
 * because only the process that made the call ever saw them.
 *
 * `bodyText` is kept alongside `body` because they are different evidence. A
 * body that failed to parse still has text, and the exact bytes matter when the
 * question is what the SDK serialised.
 */
export interface ProbeAttempt {
  surface: string;
  mode: ExchangeMode;
  method: string;
  url: string;
  /** Already through `redactHeaders`. No plaintext credential leaves here. */
  requestHeaders: Record<string, string>;
  bodyText?: string;
  body?: unknown;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBodyText?: string;
  /** Set when no response arrived at all. */
  transportError?: string;
  startedAt: string;
  /** Time to headers, and to the end of the body. Different numbers. */
  ttfbMs: number;
  totalMs: number;
}

/**
 * What the probe emits for one `create()` call.
 *
 * `attempts` is plural because both SDKs retry on their own schedule, and each
 * retry is a separate request the gateway will bill for.
 */
export interface ProbeOutcome {
  mode: Exclude<SdkMode, 'raw'>;
  ok: boolean;
  result?: unknown;
  failure?: SdkFailure;
  attempts: ProbeAttempt[];
  sdkHeaders: string[];
}

export interface AdapterInit {
  /** The gateway origin, without a trailing slash and without `/v1`. */
  baseUrl: string;
  secret: string | null;
  timeoutMs?: number;
  /** Left at 0 by default so one call is one attempt unless retries are the subject. */
  maxRetries?: number;
}

/**
 * Builds the fetch the SDK will use, plus the array it records into.
 *
 * The SDK is handed back a reconstructed `Response`, because the body has
 * already been read to record it and a body can only be read once.
 * `content-encoding` and `content-length` are dropped from the copy: what we
 * hold is already decoded, so leaving them would have the SDK try to
 * decompress plain text.
 */
type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

/**
 * Each SDK declares its own `Fetch` type over its own `Response` shim, so a
 * structurally identical function is not nominally assignable to it. The casts
 * below are at that boundary and deliberate: the runtime contract both SDKs
 * actually invoke is `(url, init) => Promise<Response>`, which is exactly what
 * `recordingFetch` provides. Taking the type from the SDK's own constructor
 * signature means a version bump that changes it becomes a compile error here
 * rather than a silent mismatch.
 */
type OpenAIFetch = NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'];
type AnthropicFetch = NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch'];

interface FetchInit {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  body?: unknown;
}

function initOf(init: unknown): FetchInit {
  return typeof init === 'object' && init !== null ? (init as FetchInit) : {};
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input !== null && 'url' in input) {
    const url = (input as { url: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return String(input);
}

function recordingFetch(
  surface: string,
  mode: ExchangeMode,
  attempts: ProbeAttempt[],
  sdkHeaders: Set<string>,
  timeoutMs: number,
): FetchLike {
  return async (input: unknown, rawInit?: unknown): Promise<Response> => {
    const init = initOf(rawInit);
    const url = urlOf(input);
    const sent: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, key) => {
      sent[key] = value;
      if (!OUR_HEADERS.has(key.toLowerCase())) sdkHeaders.add(key.toLowerCase());
    });

    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    let parsedBody: unknown;
    if (bodyText !== undefined) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        /* keep the text only */
      }
    }

    const method = (init.method ?? 'GET').toUpperCase();
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    // Masked BEFORE the record exists, not before it is emitted. A raw value
    // that is never written down cannot leak from a later code path.
    const attempt: ProbeAttempt = {
      surface,
      mode,
      method,
      url,
      requestHeaders: redactHeaders(sent),
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(parsedBody !== undefined ? { body: parsedBody } : {}),
      startedAt,
      ttfbMs: 0,
      totalMs: 0,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: sent,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      attempt.ttfbMs = round2(performance.now() - t0);

      const text = await res.text();
      attempt.totalMs = round2(performance.now() - t0);
      attempt.status = res.status;
      attempt.statusText = res.statusText;

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      attempt.responseHeaders = responseHeaders;
      if (text !== '') attempt.responseBodyText = text;
      attempts.push(attempt);

      const replayHeaders = new Headers();
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (name === 'content-encoding' || name === 'content-length') continue;
        replayHeaders.set(name, value);
      }
      return new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: replayHeaders,
      });
    } catch (error) {
      attempt.totalMs = round2(performance.now() - t0);
      attempt.transportError =
        controller.signal.aborted
          ? `Timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      attempts.push(attempt);
      // Rethrown so the SDK's own retry and error classification run, which is
      // the whole point of driving the real SDK.
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Half-up to two decimals, which is what `Math.round` does and what the Python
 * side reproduces on purpose. Kept here so a timing recorded by the probe and
 * one recorded by the engine are the same number.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function describeFailure(error: unknown): SdkFailure {
  if (!(error instanceof Error)) {
    return { name: 'unknown', message: String(error), typed: false };
  }
  const anyErr = error as Error & {
    status?: number;
    error?: { type?: unknown; code?: unknown };
    type?: unknown;
    code?: unknown;
  };
  const failure: SdkFailure = {
    name: error.constructor.name,
    message: error.message,
    // Both SDKs export APIError subclasses whose names end in `Error` and which
    // carry a status. A plain Error means the SDK could not classify it.
    typed: typeof anyErr.status === 'number',
  };
  if (typeof anyErr.status === 'number') failure.status = anyErr.status;
  const type = anyErr.error?.type ?? anyErr.type;
  const code = anyErr.error?.code ?? anyErr.code;
  if (typeof type === 'string') failure.type = type;
  if (typeof code === 'string') failure.code = code;
  return failure;
}

/** Dispatches to the SDK method matching our surface id. */
async function callOpenAI(client: OpenAI, surfaceId: string, body: unknown): Promise<unknown> {
  // The bodies are deliberately untyped — see the module comment. Casting is
  // how a malformed request reaches the SDK's wire layer at all.
  const payload = body as never;
  switch (surfaceId) {
    case 'chat.completions':
      return client.chat.completions.create(payload);
    case 'responses':
      return client.responses.create(payload);
    default:
      throw new Error(`The OpenAI SDK has no method for surface "${surfaceId}"`);
  }
}

/**
 * No reachable surface since 2026-09-02 — `/v1/messages` left the tested scope,
 * so `ANTHROPIC_SDK_SURFACES` is empty and this always throws. Kept because it
 * is the only thing that can show what `@anthropic-ai/sdk` extracts from an
 * error; restoring the surface is the only change needed to use it again.
 */
async function callAnthropic(
  _client: Anthropic,
  surfaceId: string,
  _body: unknown,
): Promise<unknown> {
  throw new Error(`The Anthropic SDK has no method for surface "${surfaceId}"`);
}

export async function runWithSdk(
  mode: Exclude<SdkMode, 'raw'>,
  surfaceId: string,
  body: unknown,
  init: AdapterInit,
): Promise<ProbeOutcome> {
  const attempts: ProbeAttempt[] = [];
  const sdkHeaders = new Set<string>();
  const timeoutMs = init.timeoutMs ?? 60_000;
  const fetchImpl = recordingFetch(surfaceId, mode, attempts, sdkHeaders, timeoutMs);
  const maxRetries = init.maxRetries ?? 0;
  const apiKey = init.secret ?? 'missing-key';

  try {
    const result =
      mode === 'openai-sdk'
        ? await callOpenAI(
            new OpenAI({
              apiKey,
              // The OpenAI SDK appends paths to a baseURL that already ends /v1.
              baseURL: `${init.baseUrl.replace(/\/+$/, '')}/v1`,
              maxRetries,
              fetch: fetchImpl as unknown as OpenAIFetch,
            }),
            surfaceId,
            body,
          )
        : await callAnthropic(
            new Anthropic({
              apiKey,
              // The Anthropic SDK adds /v1 itself.
              baseURL: init.baseUrl.replace(/\/+$/, ''),
              maxRetries,
              fetch: fetchImpl as unknown as AnthropicFetch,
            }),
            surfaceId,
            body,
          );

    return { mode, ok: true, result, attempts, sdkHeaders: [...sdkHeaders].sort() };
  } catch (error) {
    return {
      mode,
      ok: false,
      failure: describeFailure(error),
      attempts,
      sdkHeaders: [...sdkHeaders].sort(),
    };
  }
}
