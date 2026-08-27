/**
 * The lab API.
 *
 * The browser talks only to this. It never receives a raw credential and never
 * calls the gateway directly — partly so keys stay server-side, but mostly
 * because the gateway sets no CORS `ExposeHeaders`, so page JavaScript cannot
 * read `X-Request-ID`, the `X-*-Budget-*` family, `x-should-retry`,
 * `Retry-After` or `x-tokenshield-guardrail-ms`. Those headers are the signal.
 */

import { runPreflight, TokenShieldClient } from '@tokenshield/client';
import type { AuthScheme, PreflightResult } from '@tokenshield/client';
import type { FastifyInstance } from 'fastify';

import type { LabConfig } from './config.js';
import type { TargetRegistry } from './registry.js';
import type { RunStore } from './store.js';

const VALID_SCHEMES: readonly AuthScheme[] = ['bearer', 'x-api-key'];

interface PreflightBody {
  profileId?: unknown;
  keyAlias?: unknown;
  scheme?: unknown;
}

interface AddProfileBody {
  label?: unknown;
  baseUrl?: unknown;
}

interface AddKeyBody {
  alias?: unknown;
  secret?: unknown;
  kind?: unknown;
}

/** Preflight without the exchange bodies — the UI fetches those on demand. */
type PreflightResponse = Omit<PreflightResult, 'exchanges'> & {
  exchangeIds: string[];
};

export interface RouteDeps {
  config: LabConfig;
  registry: TargetRegistry;
  store: RunStore;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, registry, store } = deps;

  app.get('/api/health', () => ({
    service: 'tokenshield-lab-server',
    status: 'healthy',
    version: '0.1.0',
    uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    history: { size: store.size, capacity: store.capacity, persistence: 'none (in-memory only)' },
    sessionTargets: registry.sessionCounts,
  }));

  /** Everything the UI needs to render the Connect page. Masked values only. */
  app.get('/api/config', () => ({
    profiles: registry.profiles(),
    keys: registry.keyRefs(),
    defaults: { profileId: config.defaultProfileId, keyAlias: config.defaultKeyAlias },
    warnings: config.warnings,
    envFile: config.envFile,
    envFileFound: config.envFileFound,
    historyLimit: config.historyLimit,
  }));

  // ── Session targets ────────────────────────────────────────────────────────
  //
  // Typed into the console, held in memory, never written to disk. The request
  // body of the key route carries a live credential; Fastify's logger records
  // method and URL but not bodies, so nothing here needs redacting — but that
  // is a property worth not breaking.

  app.post<{ Body: AddProfileBody }>('/api/targets/profiles', (request, reply) => {
    const result = registry.addProfile(request.body ?? {});
    if (!result.ok) return reply.status(400).send({ error: result.error });
    app.log.info(`session gateway added: ${result.value.id} → ${result.value.baseUrl}`);
    return reply.status(201).send(result.value);
  });

  app.delete<{ Params: { id: string } }>('/api/targets/profiles/:id', (request, reply) => {
    const result = registry.removeProfile(request.params.id);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    app.log.info(`session gateway removed: ${request.params.id}`);
    return reply.status(204).send();
  });

  app.post<{ Body: AddKeyBody }>('/api/targets/keys', (request, reply) => {
    const result = registry.addKey(request.body ?? {});
    if (!result.ok) return reply.status(400).send({ error: result.error });
    // Alias and mask only — the secret is never echoed, not even back to the
    // caller that just supplied it.
    app.log.info(`session key added: ${result.value.alias} (${result.value.kind}) ${result.value.masked}`);
    return reply.status(201).send(
      result.warning !== undefined ? { ...result.value, warning: result.warning } : result.value,
    );
  });

  app.delete<{ Params: { alias: string } }>('/api/targets/keys/:alias', (request, reply) => {
    const result = registry.removeKey(request.params.alias);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    app.log.info(`session key removed: ${request.params.alias}`);
    return reply.status(204).send();
  });

  // ── Preflight ──────────────────────────────────────────────────────────────

  app.post<{ Body: PreflightBody }>('/api/preflight', async (request, reply) => {
    const body = request.body ?? {};

    const profileId = typeof body.profileId === 'string' ? body.profileId : config.defaultProfileId;
    const profile = registry.profile(profileId);
    if (profile === undefined) {
      return reply.status(400).send({ error: `Unknown profile "${profileId}"` });
    }

    const keyAlias =
      typeof body.keyAlias === 'string' && body.keyAlias.length > 0 ? body.keyAlias : null;
    let secret: string | null = null;
    if (keyAlias !== null) {
      secret = registry.secretFor(keyAlias);
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

  // ── History ────────────────────────────────────────────────────────────────

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
