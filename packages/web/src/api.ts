import type {
  AuthScheme,
  Exchange,
  ExchangeSummary,
  KeyKind,
  LabKeyRef,
  LabProfile,
  ModelInfo,
  PreflightResult,
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

  runs: (limit = 50) => json<RunsResponse>(`/api/runs?limit=${limit}`),

  exchange: (id: string) => json<Exchange>(`/api/runs/${id}`),
};
