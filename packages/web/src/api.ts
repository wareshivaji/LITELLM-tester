import type {
  AuthScheme,
  Exchange,
  ExchangeSummary,
  KeyRef,
  PreflightResult,
  Profile,
} from '@tokenshield/client';

export interface LabConfigResponse {
  profiles: Profile[];
  keys: KeyRef[];
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

  preflight: (body: { profileId: string; keyAlias: string | null; scheme: AuthScheme }) =>
    json<PreflightResponse>('/api/preflight', { method: 'POST', body: JSON.stringify(body) }),

  runs: (limit = 50) => json<RunsResponse>(`/api/runs?limit=${limit}`),

  exchange: (id: string) => json<Exchange>(`/api/runs/${id}`),
};
