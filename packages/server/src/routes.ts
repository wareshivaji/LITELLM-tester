/**
 * The lab API.
 *
 * The browser talks only to this. It never receives a raw credential and never
 * calls the gateway directly — partly so keys stay server-side, but mostly
 * because the gateway sets no CORS `ExposeHeaders`, so page JavaScript cannot
 * read `X-Request-ID`, the `X-*-Budget-*` family, `x-should-retry`,
 * `Retry-After` or `x-tokenshield-guardrail-ms`. Those headers are the signal.
 */

import { extractModels, runPreflight, surfaceById, TokenShieldClient } from '@tokenshield/client';
import type { AuthScheme, PreflightResult, Profile } from '@tokenshield/client';
import type { FastifyInstance } from 'fastify';

import type { LabConfig } from './config.js';
import type { TargetRegistry } from './registry.js';
import type { RunStore } from './store.js';

const VALID_SCHEMES: readonly AuthScheme[] = ['bearer', 'x-api-key'];

interface TargetBody {
  profileId?: unknown;
  keyAlias?: unknown;
  scheme?: unknown;
}

interface ExchangeBody extends TargetBody {
  surfaceId?: unknown;
  body?: unknown;
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

interface ResolvedTarget {
  profile: Profile;
  keyAlias: string | null;
  secret: string | null;
  scheme: AuthScheme;
}

export interface RouteDeps {
  config: LabConfig;
  registry: TargetRegistry;
  store: RunStore;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, registry, store } = deps;

  /**
   * Every call-making route resolves its target the same way, so a profile or
   * alias that does not exist fails identically everywhere.
   */
  function resolveTarget(
    body: TargetBody,
  ): { ok: true; value: ResolvedTarget } | { ok: false; error: string } {
    const profileId =
      typeof body.profileId === 'string' ? body.profileId : config.defaultProfileId;
    const profile = registry.profile(profileId);
    if (profile === undefined) return { ok: false, error: `Unknown profile "${profileId}"` };

    const keyAlias =
      typeof body.keyAlias === 'string' && body.keyAlias.length > 0 ? body.keyAlias : null;
    let secret: string | null = null;
    if (keyAlias !== null) {
      secret = registry.secretFor(keyAlias);
      if (secret === null) return { ok: false, error: `Unknown key alias "${keyAlias}"` };
    }

    const requested = typeof body.scheme === 'string' ? (body.scheme as AuthScheme) : 'bearer';
    const scheme: AuthScheme = VALID_SCHEMES.includes(requested) ? requested : 'bearer';

    return { ok: true, value: { profile, keyAlias, secret, scheme: secret !== null ? scheme : 'none' } };
  }

  function clientFor(target: ResolvedTarget): TokenShieldClient {
    return new TokenShieldClient({
      profile: target.profile,
      keyAlias: target.keyAlias,
      secret: target.secret,
      scheme: target.scheme,
      timeoutMs: config.timeoutMs,
    });
  }

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
  // Typed into the console, held in memory, never written to disk. The key
  // route's request body carries a live credential; Fastify's logger records
  // method and URL but not bodies, so nothing here leaks — a property worth
  // not breaking.

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
    app.log.info(
      `session key added: ${result.value.alias} (${result.value.kind}) ${result.value.masked}`,
    );
    return reply
      .status(201)
      .send(result.warning !== undefined ? { ...result.value, warning: result.warning } : result.value);
  });

  app.delete<{ Params: { alias: string } }>('/api/targets/keys/:alias', (request, reply) => {
    const result = registry.removeKey(request.params.alias);
    if (!result.ok) return reply.status(400).send({ error: result.error });
    app.log.info(`session key removed: ${request.params.alias}`);
    return reply.status(204).send();
  });

  // ── Calls ──────────────────────────────────────────────────────────────────

  app.post<{ Body: TargetBody }>('/api/preflight', async (request, reply) => {
    const target = resolveTarget(request.body ?? {});
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const client = clientFor(target.value);
    const result = await runPreflight(client, { hasKey: target.value.secret !== null });
    store.addAll(result.exchanges);

    app.log.info(
      `preflight ${target.value.profile.id} (${target.value.profile.baseUrl}) key=${target.value.keyAlias ?? 'none'} → ${result.ok ? 'ok' : 'FAILED'} in ${result.durationMs}ms`,
    );

    const { exchanges, ...rest } = result;
    const response: PreflightResponse = { ...rest, exchangeIds: exchanges.map((e) => e.id) };
    return response;
  });

  /** The model catalogue on its own, for the Playground's picker. Free. */
  app.post<{ Body: TargetBody }>('/api/models', async (request, reply) => {
    const target = resolveTarget(request.body ?? {});
    if (!target.ok) return reply.status(400).send({ error: target.error });
    if (target.value.secret === null) {
      return reply.status(400).send({ error: 'A key is required to list the models it may use.' });
    }

    const exchange = await clientFor(target.value).listModels();
    store.add(exchange);

    if (exchange.verdict.kind !== 'ok') {
      return reply
        .status(200)
        .send({ models: [], exchangeId: exchange.id, verdict: exchange.verdict });
    }
    return {
      models: extractModels(exchange.response?.body),
      exchangeId: exchange.id,
      verdict: exchange.verdict,
    };
  });

  /**
   * One inference call. This is the route that spends money: everything above
   * is free, and everything here reaches a provider unless the gateway rejects
   * it first.
   *
   * The request body is forwarded verbatim. No validation, no normalisation —
   * sending a deliberately malformed body is the entire point of the surface.
   */
  app.post<{ Body: ExchangeBody }>('/api/exchange', async (request, reply) => {
    const raw = request.body ?? {};

    const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
    const surface = surfaceById(surfaceId);
    if (surface === undefined) {
      return reply.status(400).send({ error: `Unknown surface "${surfaceId}"` });
    }

    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const exchange = await clientFor(target.value).call(surface, raw.body);
    store.add(exchange);

    app.log.info(
      `${surface.id} → ${exchange.response?.status ?? 'no response'} ${exchange.verdict.kind} ` +
        `in ${exchange.timings.totalMs}ms (${target.value.profile.id}, key=${target.value.keyAlias ?? 'none'})`,
    );

    return exchange;
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
