import { SSEParser } from '@tokenshield/client';
import type {
  AuthScheme,
  Exchange,
  ExchangeSummary,
  KeyKind,
  LabKeyRef,
  LabProfile,
  ModelInfo,
  PreflightResult,
  MintedKeySummary,
  SdkMode,
  SdkOutcome,
  StreamChunk,
  Verdict,
} from '@tokenshield/client';

export interface TargetRef {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
}

export interface LabConfigResponse {
  profiles: LabProfile[];
  keys: LabKeyRef[];
  defaults: { profileId: string; keyAlias: string | null };
  warnings: string[];
  envFile: string;
  envFileFound: boolean;
  historyLimit: number;
}

/** Preflight minus the exchange bodies — the log fetches those on demand. */
export type PreflightResponse = Omit<PreflightResult, 'exchanges'> & { exchangeIds: string[] };

export interface MintResult {
  ok: boolean;
  key?: MintedKeySummary;
  verdict?: Verdict;
  status?: number | null;
  exchangeId: string;
}

export interface BurstResult {
  attempted: number;
  requested: number;
  /** Set when the burst gave up because the gateway was broken, not limiting. */
  abandoned: string | null;
  firstRejectedAt: number | null;
  elapsedMs: number;
  statuses: number[];
  verdict: Verdict | null;
  retryAfterSeconds: number | null;
  rejectedExchangeId: string | null;
  firstExchangeId: string | null;
}

export interface ProbeResult {
  results: Array<{
    model: string;
    status: number | null;
    verdict: string;
    code?: string;
    detail: string;
    exchangeId: string;
  }>;
}

export interface RunsResponse {
  total: number;
  capacity: number;
  exchanges: ExchangeSummary[];
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? message;
    } catch {
      if (text.length > 0) message = text;
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/**
 * Streams a call through the backend relay.
 *
 * The relay speaks SSE, so this parses it with the SDK's own `SSEParser` — the
 * same machine the backend used on the gateway's stream. One parser, one set
 * of edge cases (CRLF frames, multi-byte characters split across reads).
 *
 * Aborting the fetch closes the request, which the backend sees and propagates
 * to the gateway.
 */
async function streamSurface(
  body: TargetRef & { surfaceId: string; body: unknown },
  handlers: {
    onChunk: (chunk: StreamChunk) => void;
    onDone: (exchange: Exchange) => void;
    onError: (message: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const res = await fetch('/api/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(handlers.signal !== undefined ? { signal: handlers.signal } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      if (text.length > 0) message = text;
    }
    handlers.onError(message);
    return;
  }
  if (res.body === null) {
    handlers.onError('The relay returned no body.');
    return;
  }

  const parser = new SSEParser();
  const reader = res.body.getReader();

  const dispatch = (frames: StreamChunk[]): void => {
    for (const frame of frames) {
      if (frame.event === 'chunk') handlers.onChunk(frame.parsed as StreamChunk);
      else if (frame.event === 'done') handlers.onDone(frame.parsed as Exchange);
      else if (frame.event === 'error') {
        handlers.onError((frame.parsed as { error?: string })?.error ?? 'Relay error');
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) dispatch(parser.push(value, 0));
  }
  dispatch(parser.flush(0));
}

export const api = {
  config: () => json<LabConfigResponse>('/api/config'),

  addProfile: (body: { label: string; baseUrl: string }) =>
    json<LabProfile>('/api/targets/profiles', { method: 'POST', body: JSON.stringify(body) }),

  removeProfile: (id: string) =>
    json<void>(`/api/targets/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** The pasted secret goes over loopback once and is never returned. */
  addKey: (body: { alias: string; secret: string; kind: KeyKind }) =>
    json<LabKeyRef & { warning?: string }>('/api/targets/keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeKey: (alias: string) =>
    json<void>(`/api/targets/keys/${encodeURIComponent(alias)}`, { method: 'DELETE' }),

  preflight: (body: TargetRef) =>
    json<PreflightResponse>('/api/preflight', { method: 'POST', body: JSON.stringify(body) }),

  /** Free — one GET /v1/models, filtered by the key's allowedModels. */
  models: (body: TargetRef) =>
    json<{ models: ModelInfo[]; exchangeId: string; verdict: Verdict }>('/api/models', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** The one call that spends money. Body is forwarded verbatim. */
  callSurface: (body: TargetRef & { surfaceId: string; body: unknown }) =>
    json<Exchange>('/api/exchange', { method: 'POST', body: JSON.stringify(body) }),

  streamSurface,

  /** The same body through several clients, run sequentially on the server. */
  compare: (
    body: TargetRef & {
      surfaceId: string;
      body: unknown;
      modes: SdkMode[];
      maxRetries: number;
    },
  ) =>
    json<{ surfaceId: string; outcomes: SdkOutcome[] }>('/api/compare', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Mints a cg-ak- key. The raw value stays in the backend; this returns a mask. */
  mintKey: (body: TargetRef & { managementAlias: string; request: unknown }) =>
    json<MintResult>('/api/keys/mint', { method: 'POST', body: JSON.stringify(body) }),

  /** Bursts GET /v1/models until the limiter refuses. Free — no provider call. */
  burst: (body: TargetRef & { count: number }) =>
    json<BurstResult>('/api/governance/burst', { method: 'POST', body: JSON.stringify(body) }),

  /** Probes model permission with the non-generating token counter. Free. */
  probeModels: (body: TargetRef & { models?: string[] }) =>
    json<ProbeResult>('/api/governance/probe-models', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  runs: (limit = 50) => json<RunsResponse>(`/api/runs?limit=${limit}`),

  exchange: (id: string) => json<Exchange>(`/api/runs/${id}`),
};
