/**
 * The lab API.
 *
 * The browser talks only to this. It never sees a raw credential and never
 * calls the gateway directly — partly so keys stay server-side, but mostly
 * because the gateway sets no CORS `ExposeHeaders`, so page JavaScript cannot
 * read `X-Request-ID`, the `X-*-Budget-*` family, `x-should-retry`,
 * `Retry-After` or `x-tokenshield-guardrail-ms`. Those headers are the signal.
 */

import { runPreflight, TokenShieldClient } from '@tokenshield/client';
import type { AuthScheme, PreflightResult } from '@tokenshield/client';
import type { FastifyInstance } from 'fastify';

import type { LabConfig } from './config.js';
import type { RunStore } from './store.js';

const VALID_SCHEMES: readonly AuthScheme[] = ['bearer', 'x-api-key'];

interface PreflightBody {
  profileId?: unknown;
  keyAlias?: unknown;
  scheme?: unknown;
}

/** Preflight without the exchange bodies — the UI fetches those on demand. */
type PreflightResponse = Omit<PreflightResult, 'exchanges'> & {
  exchangeIds: string[];
};

export interface RouteDeps {
  config: LabConfig;
  store: RunStore;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, store } = deps;

  app.get('/api/health', () => ({
    service: 'tokenshield-lab-server',
    status: 'healthy',
    version: '0.1.0',
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    history: { size: store.size, capacity: store.capacity, persistence: 'none (in-memory only)' },
  }));

  /** Everything the UI needs to render the Connect page. Masked values only. */
  app.get('/api/config', () => ({
    profiles: config.profiles,
    keys: config.keyRefs,
    defaults: { profileId: config.defaultProfileId, keyAlias: config.defaultKeyAlias },
    warnings: config.warnings,
    envFile: config.envFile,
    envFileFound: config.envFileFound,
    historyLimit: config.historyLimit,
  }));

  app.post<{ Body: PreflightBody }>('/api/preflight', async (request, reply) => {
    const body = request.body ?? {};

    const profileId = typeof body.profileId === 'string' ? body.profileId : config.defaultProfileId;
    const profile = config.profile(profileId);
    if (profile === undefined) {
      return reply.status(400).send({ error: `Unknown profile "${profileId}"` });
    }

    const keyAlias = typeof body.keyAlias === 'string' && body.keyAlias.length > 0 ? body.keyAlias : null;
    let secret: string | null = null;
    if (keyAlias !== null) {
      secret = config.secretFor(keyAlias);
      if (secret === null) {
        return reply.status(400).send({ error: `Unknown key alias "${keyAlias}"` });
      }
    }

    const requested = typeof body.scheme === 'string' ? (body.scheme as AuthScheme) : 'bearer';
    const scheme: AuthScheme = VALID_SCHEMES.includes(requested) ? requested : 'bearer';

    const client = new TokenShieldClient({
      profile,
      keyAlias,
      secret,
      scheme: secret !== null ? scheme : 'none',
      timeoutMs: config.timeoutMs,
    });

    const result = await runPreflight(client, { hasKey: secret !== null });
    store.addAll(result.exchanges);

    app.log.info(
      `preflight ${profile.id} (${profile.baseUrl}) key=${keyAlias ?? 'none'} → ${result.ok ? 'ok' : 'FAILED'} in ${result.durationMs}ms`,
    );

    const { exchanges, ...rest } = result;
    const response: PreflightResponse = { ...rest, exchangeIds: exchanges.map((e) => e.id) };
    return response;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/runs', (request) => {
    const raw = request.query.limit;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    return { total: store.size, capacity: store.capacity, exchanges: store.list(limit) };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', (request, reply) => {
    const exchange = store.get(request.params.id);
    if (exchange === undefined) {
      return reply.status(404).send({ error: 'No such exchange in this session’s history' });
    }
    return exchange;
  });

  app.delete('/api/runs', (_request, reply) => {
    store.clear();
    return reply.status(204).send();
  });
}
