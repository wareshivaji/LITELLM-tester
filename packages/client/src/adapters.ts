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
 * The mechanism is a `fetch` implementation handed to the SDK's constructor. It
 * records through `Transport.sendRaw`, so an SDK call and a hand-built call
 * produce the same Exchange shape and are directly comparable. Nothing rewrites
 * the SDK's request: seeing what it constructs is the point.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { Transport } from './transport.js';
import type { Exchange, ExchangeMode, Profile } from './types.js';

/** Which client made the call. */
export type SdkMode = 'raw' | 'openai-sdk' | 'anthropic-sdk';

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

/** Surfaces each vendor SDK can actually reach, by our surface id. */
export const OPENAI_SDK_SURFACES = [
  'chat.completions',
  'completions',
  'embeddings',
  'responses',
  'moderations',
] as const;

// `messages.count_tokens` is absent from @anthropic-ai/sdk 0.32's typed
// surface, so it stays raw-only rather than being reached through an untyped
// escape hatch that would not represent what a customer writes.
export const ANTHROPIC_SDK_SURFACES = ['messages'] as const;

export function sdkModesFor(surfaceId: string): SdkMode[] {
  const modes: SdkMode[] = ['raw'];
  if ((OPENAI_SDK_SURFACES as readonly string[]).includes(surfaceId)) modes.push('openai-sdk');
  if ((ANTHROPIC_SDK_SURFACES as readonly string[]).includes(surfaceId)) modes.push('anthropic-sdk');
  return modes;
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

export interface AdapterInit {
  profile: Profile;
  keyAlias: string | null;
  secret: string | null;
  timeoutMs?: number;
  /** Left at 0 by default so one call is one attempt unless retries are the subject. */
  maxRetries?: number;
}

/**
 * Builds the fetch the SDK will use, plus the array it records into.
 *
 * The SDK is handed back a reconstructed `Response`, because `sendRaw` has
 * already read the body to record it and a stream can only be read once.
 * `content-encoding` and `content-length` are dropped from the copy: the body
 * we hold is already decoded, so leaving them would have the SDK try to
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
  transport: Transport,
  surface: string,
  mode: ExchangeMode,
  attempts: Exchange[],
  sdkHeaders: Set<string>,
): FetchLike {
  return async (input: unknown, rawInit?: unknown): Promise<Response> => {
    const init = initOf(rawInit);
    const url = urlOf(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
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

    const exchange = await transport.sendRaw({
      surface,
      mode,
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers,
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(parsedBody !== undefined ? { body: parsedBody } : {}),
    });
    attempts.push(exchange);

    if (exchange.transportError !== undefined || exchange.response === undefined) {
      throw new Error(exchange.transportError ?? 'no response');
    }

    const replayHeaders = new Headers();
    for (const [name, value] of Object.entries(exchange.response.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'content-encoding' || lower === 'content-length') continue;
      replayHeaders.set(name, value);
    }

    return new Response(exchange.response.bodyText ?? '', {
      status: exchange.response.status,
      statusText: exchange.response.statusText,
      headers: replayHeaders,
    });
  };
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
    case 'completions':
      return client.completions.create(payload);
    case 'embeddings':
      return client.embeddings.create(payload);
    case 'responses':
      return client.responses.create(payload);
    case 'moderations':
      return client.moderations.create(payload);
    default:
      throw new Error(`The OpenAI SDK has no method for surface "${surfaceId}"`);
  }
}

async function callAnthropic(client: Anthropic, surfaceId: string, body: unknown): Promise<unknown> {
  const payload = body as never;
  switch (surfaceId) {
    case 'messages':
      return client.messages.create(payload);
    default:
      throw new Error(`The Anthropic SDK has no method for surface "${surfaceId}"`);
  }
}

export async function runWithSdk(
  mode: Exclude<SdkMode, 'raw'>,
  surfaceId: string,
  body: unknown,
  init: AdapterInit,
): Promise<SdkOutcome> {
  const transport = new Transport({
    profile: init.profile,
    keyAlias: init.keyAlias,
    secret: init.secret,
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
  });

  const attempts: Exchange[] = [];
  const sdkHeaders = new Set<string>();
  const fetchImpl = recordingFetch(transport, surfaceId, mode, attempts, sdkHeaders);
  const maxRetries = init.maxRetries ?? 0;
  const apiKey = init.secret ?? 'missing-key';

  try {
    const result =
      mode === 'openai-sdk'
        ? await callOpenAI(
            new OpenAI({
              apiKey,
              // The OpenAI SDK appends paths to a baseURL that already ends /v1.
              baseURL: `${init.profile.baseUrl.replace(/\/+$/, '')}/v1`,
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
              baseURL: init.profile.baseUrl.replace(/\/+$/, ''),
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
