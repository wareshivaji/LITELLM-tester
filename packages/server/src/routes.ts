/**
 * The lab API.
 *
 * The browser talks only to this. It never receives a raw credential and never
 * calls the gateway directly — partly so keys stay server-side, but mostly
 * because the gateway sets no CORS `ExposeHeaders`, so page JavaScript cannot
 * read `X-Request-ID`, the `X-*-Budget-*` family, `x-should-retry`,
 * `Retry-After` or `x-tokenshield-guardrail-ms`. Those headers are the signal.
 */

import {
  CROSS_PROVIDER_PROBES,
  extractModels,
  isStreamable,
  readCreatedKey,
  redactMintedKey,
  runPreflight,
  runWithSdk,
  sdkModesFor,
  summariseMintedKey,
  surfaceById,
  TokenShieldClient,
} from '@tokenshield/client';
import type {
  AuthScheme,
  CreateApiKeyRequest,
  Exchange,
  PreflightResult,
  Profile,
  SdkMode,
  SdkOutcome,
} from '@tokenshield/client';
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

interface CompareBody extends ExchangeBody {
  modes?: unknown;
  maxRetries?: unknown;
}

interface MintBody extends TargetBody {
  managementAlias?: unknown;
  request?: unknown;
}

interface BurstBody extends TargetBody {
  count?: unknown;
}

interface ProbeBody extends TargetBody {
  models?: unknown;
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

  /**
   * One streaming call, relayed to the browser as SSE.
   *
   * Two streams, not one: the gateway's frames arrive here, get recorded with
   * their arrival times, and are re-emitted in an envelope the console can
   * parse with the same SDK parser. The recording is the reason for the hop —
   * a browser reading the gateway directly could neither see the response
   * headers nor keep the key out of the page.
   *
   * `reply.hijack()` hands the socket over: from that point Fastify sends
   * nothing, so validation happens *before* it and errors after it travel as
   * an `error` event rather than an HTTP status.
   */
  app.post<{ Body: ExchangeBody }>('/api/stream', async (request, reply) => {
    const raw = request.body ?? {};

    const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
    const surface = surfaceById(surfaceId);
    if (surface === undefined) {
      return reply.status(400).send({ error: `Unknown surface "${surfaceId}"` });
    }
    if (!isStreamable(surface)) {
      return reply.status(400).send({ error: `${surface.label} does not support streaming` });
    }

    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vite's dev proxy will buffer an event stream without this.
      'X-Accel-Buffering': 'no',
    });

    const emit = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // The console's Stop button closes this request. Propagate that upstream so
    // the gateway connection is dropped too, rather than left generating tokens
    // nobody is reading.
    //
    // Listen on the RESPONSE stream, not the request. Since Node 16 an
    // IncomingMessage emits 'close' once its body has been consumed — which
    // Fastify has already done to parse the JSON — so a request-side listener
    // fires within a millisecond and aborts every stream before the first
    // frame. The ServerResponse's 'close' is the socket actually going away.
    const upstream = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) upstream.abort();
    });

    try {
      const exchange = await clientFor(target.value).callStream(surface, raw.body, {
        onChunk: (chunk) => emit('chunk', chunk),
        signal: upstream.signal,
      });
      finished = true;
      store.add(exchange);
      app.log.info(
        `stream ${surface.id} → ${exchange.response?.status ?? 'incomplete'} ` +
          `${exchange.response?.chunks?.length ?? 0} frame(s) in ${exchange.timings.totalMs}ms ` +
          `(${target.value.profile.id}, key=${target.value.keyAlias ?? 'none'})`,
      );
      emit('done', exchange);
    } catch (error) {
      finished = true;
      emit('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /**
   * The same request, sent by up to three different clients.
   *
   * Modes run **sequentially, never in parallel.** The per-key rate limiter
   * defaults to 60 requests a minute, and firing three concurrent calls (each
   * of which may retry) is a good way to turn a comparison into a 429 and learn
   * nothing about the thing being compared.
   */
  app.post<{ Body: CompareBody }>('/api/compare', async (request, reply) => {
    const raw = request.body ?? {};

    const surfaceId = typeof raw.surfaceId === 'string' ? raw.surfaceId : '';
    const surface = surfaceById(surfaceId);
    if (surface === undefined) {
      return reply.status(400).send({ error: `Unknown surface "${surfaceId}"` });
    }

    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const allowed = sdkModesFor(surface.id);
    const requested: unknown[] = Array.isArray(raw.modes) ? raw.modes : [];
    const modes: SdkMode[] = allowed.filter((m) => requested.includes(m));
    if (modes.length === 0) {
      return reply
        .status(400)
        .send({ error: `Pick at least one of: ${allowed.join(', ')} for ${surface.label}` });
    }

    const maxRetries =
      typeof raw.maxRetries === 'number' && raw.maxRetries >= 0 && raw.maxRetries <= 5
        ? raw.maxRetries
        : 0;

    const outcomes: SdkOutcome[] = [];
    for (const mode of modes) {
      if (mode === 'raw') {
        const exchange = await clientFor(target.value).call(surface, raw.body);
        store.add(exchange);
        outcomes.push({
          mode: 'raw',
          ok: exchange.verdict.kind === 'ok',
          ...(exchange.response?.body !== undefined ? { result: exchange.response.body } : {}),
          attempts: [exchange],
          sdkHeaders: [],
        });
        continue;
      }

      const outcome = await runWithSdk(mode, surface.id, raw.body, {
        profile: target.value.profile,
        keyAlias: target.value.keyAlias,
        secret: target.value.secret,
        timeoutMs: config.timeoutMs,
        maxRetries,
      });
      store.addAll(outcome.attempts);
      outcomes.push(outcome);
    }

    app.log.info(
      `compare ${surface.id} [${modes.join(', ')}] → ` +
        outcomes.map((o) => `${o.mode}:${o.ok ? 'ok' : 'fail'}(${o.attempts.length})`).join(' '),
    );

    return { surfaceId: surface.id, outcomes };
  });

  // ── Governance ─────────────────────────────────────────────────────────────

  /**
   * Mint a disposable `cg-ak-` key with a management key.
   *
   * The gateway's response body carries the raw new key — the only response in
   * this tool that does. It is extracted, registered as a session credential,
   * and then **scrubbed out of the recorded Exchange** before that reaches the
   * store, so it never appears in the log, the inspector, or an export. The
   * browser gets an alias and a mask.
   */
  app.post<{ Body: MintBody }>('/api/keys/mint', async (request, reply) => {
    const raw = request.body ?? {};

    const managementAlias = typeof raw.managementAlias === 'string' ? raw.managementAlias : '';
    const managementRef = registry.keyRefs().find((k) => k.alias === managementAlias);
    if (managementRef === undefined || managementRef.kind !== 'management') {
      return reply
        .status(400)
        .send({ error: 'Pick a management key (cg-mk-). Add one as TSLAB_MGMT_<ALIAS> or in the console.' });
    }
    const managementSecret = registry.secretFor(managementAlias);
    if (managementSecret === null) {
      return reply.status(400).send({ error: `Unknown management key "${managementAlias}"` });
    }

    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const spec = raw.request;
    if (typeof spec !== 'object' || spec === null) {
      return reply.status(400).send({ error: 'A key specification is required.' });
    }
    const keyRequest = spec as CreateApiKeyRequest;
    if (typeof keyRequest.name !== 'string' || keyRequest.name.trim().length === 0) {
      return reply.status(400).send({ error: 'The key needs a name.' });
    }

    const exchange = await clientFor(target.value).createApiKey(keyRequest, managementSecret);
    const created = readCreatedKey(exchange.response?.body);

    // Redact BEFORE storing, always — including on the failure path, where a
    // partial body might still carry something.
    const safe = created !== undefined ? redactMintedKey(exchange, created.api_key) : exchange;
    store.add(safe);

    if (created === undefined) {
      app.log.info(`mint failed: ${safe.verdict.kind} — ${safe.verdict.detail}`);
      return reply.status(200).send({
        ok: false,
        verdict: safe.verdict,
        status: safe.response?.status ?? null,
        exchangeId: safe.id,
      });
    }

    // A unique alias, derived from the name the operator chose.
    const base =
      keyRequest.name
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'MINTED';
    let alias = base;
    for (let n = 2; registry.keyRefs().some((k) => k.alias === alias); n++) alias = `${base}_${n}`;

    const added = registry.addKey({ alias, secret: created.api_key, kind: 'api' });
    if (!added.ok) return reply.status(500).send({ error: added.error });

    app.log.info(`minted ${alias} (${added.value.masked}) via ${managementAlias}`);
    return reply.status(201).send({
      ok: true,
      key: summariseMintedKey(alias, created, keyRequest.name),
      exchangeId: safe.id,
    });
  });

  /**
   * Burst until the rate limiter refuses.
   *
   * `GET /v1/models` runs the whole middleware chain — auth, ip allowlist, rate
   * limit — but calls no provider, so a hundred of them cost nothing. That is
   * the only reason this is safe to offer as a button.
   *
   * Attempts are deliberately NOT all stored: a hundred rows would evict the
   * entire ring buffer and lose whatever the operator was actually looking at.
   * The first attempt and the rejected one are kept; the rest are counted.
   */
  app.post<{ Body: BurstBody }>('/api/governance/burst', async (request, reply) => {
    const raw = request.body ?? {};
    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });
    if (target.value.secret === null) {
      return reply.status(400).send({ error: 'A key is required — the limiter is per key.' });
    }

    const requested = typeof raw.count === 'number' ? Math.floor(raw.count) : 80;
    const count = Math.min(Math.max(requested, 1), 150);

    const client = clientFor(target.value);
    const statuses: number[] = [];
    let firstRejectedAt: number | null = null;
    let rejected: Exchange | undefined;
    let first: Exchange | undefined;
    let abandoned: string | null = null;
    let consecutiveBroken = 0;
    const startedAt = Date.now();

    for (let i = 0; i < count; i++) {
      const exchange = await client.listModels(15_000);
      if (i === 0) first = exchange;
      const status = exchange.response?.status ?? 0;
      statuses.push(status);

      if (exchange.verdict.kind === 'ratelimit' || status === 429) {
        firstRejectedAt = i + 1;
        rejected = exchange;
        break;
      }

      // Give up early if the gateway is answering with something that is
      // neither success nor a rate-limit. A gateway whose auth store is
      // unreachable answers 500 after a five-second timeout, so a blind
      // hundred-request burst spends eight minutes learning nothing. Three in a
      // row is enough to conclude the limiter is not what we are measuring.
      if (status === 200) {
        consecutiveBroken = 0;
      } else {
        consecutiveBroken++;
        if (consecutiveBroken >= 3) {
          abandoned =
            `Stopped after ${i + 1} requests: ${consecutiveBroken} consecutive ${status} responses. ` +
            `The limiter cannot be measured while the gateway is answering ${exchange.verdict.kind}.`;
          rejected = exchange;
          break;
        }
      }
    }

    if (first !== undefined) store.add(first);
    if (rejected !== undefined) store.add(rejected);

    app.log.info(
      `burst ${statuses.length} request(s) on ${target.value.keyAlias ?? 'none'} → ` +
        (abandoned !== null
          ? 'abandoned'
          : firstRejectedAt === null
            ? 'never refused'
            : `refused at #${firstRejectedAt}`),
    );

    return {
      attempted: statuses.length,
      requested: count,
      abandoned,
      firstRejectedAt,
      elapsedMs: Date.now() - startedAt,
      statuses,
      verdict: rejected?.verdict ?? null,
      retryAfterSeconds: rejected?.gateway.retryAfterSeconds ?? null,
      rejectedExchangeId: rejected?.id ?? null,
      firstExchangeId: first?.id ?? null,
    };
  });

  /**
   * Which models is this key refused, and how?
   *
   * Probes with `POST /v1/tokens/count`, not a completion: it takes a model and
   * generates nothing, so the probe is free whichever way it lands. The
   * distinction being hunted is 404 (the gateway has never heard of the model)
   * versus 403 model_not_allowed_for_key (it routes the model but this key may
   * not use it) — only the second exercises the gate. A 200 on a model absent
   * from the key's catalogue would itself be a finding: a gate not applied on
   * that surface.
   */
  app.post<{ Body: ProbeBody }>('/api/governance/probe-models', async (request, reply) => {
    const raw = request.body ?? {};
    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const candidates = Array.isArray(raw.models)
      ? raw.models.filter((m): m is string => typeof m === 'string').slice(0, 12)
      : [...CROSS_PROVIDER_PROBES];

    const surface = surfaceById('tokens.count');
    if (surface === undefined) return reply.status(500).send({ error: 'tokens.count surface missing' });

    const client = clientFor(target.value);
    const results: Array<{
      model: string;
      status: number | null;
      verdict: string;
      code?: string;
      detail: string;
      exchangeId: string;
    }> = [];

    for (const model of candidates) {
      const exchange = await client.call(surface, {
        model,
        messages: [{ role: 'user', content: 'x' }],
      });
      store.add(exchange);
      results.push({
        model,
        status: exchange.response?.status ?? null,
        verdict: exchange.verdict.kind,
        ...(exchange.verdict.code !== undefined ? { code: exchange.verdict.code } : {}),
        detail: exchange.verdict.detail,
        exchangeId: exchange.id,
      });
    }

    return { results };
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
