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
  readMcpServers,
  readMcpTools,
  redactMintedKey,
  runPreflight,
  runWithSdk,
  sdkModesFor,
  evaluateScenario,
  extractResponsesToolCalls,
  extractToolCalls,
  looksSwallowed,
  readOutput,
  reportToMarkdown,
  suiteById,
  SUITES,
  tally,
  summariseMintedKey,
  summariseTurn,
  surfaceById,
  TokenShieldClient,
  toolPresetById,
} from '@tokenshield/client';
import type {
  AuthScheme,
  CreateApiKeyRequest,
  Exchange,
  PreflightResult,
  Profile,
  ScenarioReport,
  ScenarioResult,
  SdkMode,
  SdkOutcome,
  ToolTurn,
} from '@tokenshield/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { REPO_ROOT } from './config.js';
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

interface ToolLoopBody extends TargetBody {
  model?: unknown;
  prompt?: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  /** 'chat.completions' (default) or 'responses'. */
  surfaceId?: unknown;
  /** Send the other surface's tool shape on purpose. */
  wrongToolShape?: unknown;
}

type McpBody = TargetBody;

interface McpCallBody extends TargetBody {
  server?: unknown;
  name?: unknown;
  arguments?: unknown;
}

interface ScenarioRunBody {
  suiteId?: unknown;
  targets?: unknown;
  model?: unknown;
  embedModel?: unknown;
  paceMs?: unknown;
  includeSpending?: unknown;
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

  /** The most recent suite run, held for export. In memory like everything else. */
  let lastReport: ScenarioReport | null = null;

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

  // ── Tools & MCP ────────────────────────────────────────────────────────────

  /**
   * Run a client-declared tool conversation to completion.
   *
   * Turn 1 offers `tools[]`. If the model answers with calls, they are executed
   * against the canned local implementations and the results are sent back as a
   * second turn. Both exchanges are recorded, so the timeline shows what the
   * client actually had to do to get one reply.
   *
   * The thing this is really asking: **does a client's own tool call reach the
   * client?** An org with MCP servers enabled runs its own tool loop, and a tool
   * absent from the gateway's MCP index may be answered on the model's behalf
   * rather than handed back — which would make client-declared tools unusable
   * for that org without anything ever returning an error.
   */
  app.post<{ Body: ToolLoopBody }>('/api/tools/loop', async (request, reply) => {
    const raw = request.body ?? {};
    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const model = typeof raw.model === 'string' ? raw.model : '';
    if (model.length === 0) return reply.status(400).send({ error: 'A model is required.' });

    const presetIds = Array.isArray(raw.tools)
      ? raw.tools.filter((t): t is string => typeof t === 'string')
      : ['get_weather'];
    const presets = presetIds
      .map((id) => toolPresetById(id))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    if (presets.length === 0) return reply.status(400).send({ error: 'Pick at least one tool.' });

    // Which surface, and therefore which tool shape. The gateway reads client
    // tool names from a different place on each: nested under `function` for
    // chat, top level for Responses. A client that reuses a chat definition on
    // /v1/responses declares a tool whose name the gateway cannot see, so the
    // shape is chosen per surface rather than assumed.
    const surfaceId = raw.surfaceId === 'responses' ? 'responses' : 'chat.completions';
    const onResponses = surfaceId === 'responses';
    const surface = surfaceById(surfaceId);
    if (surface === undefined) {
      return reply.status(500).send({ error: surfaceId + ' surface missing' });
    }

    // Sending the WRONG shape on purpose is a supported test: it is a realistic
    // client mistake and the gateway's behaviour for it is worth knowing.
    const useWrongShape = raw.wrongToolShape === true;
    const toolDefs = presets.map((preset) =>
      onResponses === useWrongShape ? preset.definition : preset.responsesDefinition,
    );

    const prompt =
      typeof raw.prompt === 'string' && raw.prompt.length > 0
        ? raw.prompt
        : 'What is the weather in Paris?';

    const messages: unknown[] = [{ role: 'user', content: prompt }];
    const body: Record<string, unknown> = onResponses
      ? { model, input: prompt, max_output_tokens: 256, tools: toolDefs }
      : { model, messages, max_tokens: 256, tools: toolDefs };
    if (typeof raw.toolChoice === 'string' && raw.toolChoice !== 'auto') {
      // A named choice is `{type:'function',function:{name}}`; 'none'/'required'
      // are bare strings. Passed through exactly as a client would send them.
      body['tool_choice'] =
        raw.toolChoice === 'none' || raw.toolChoice === 'required'
          ? raw.toolChoice
          : { type: 'function', function: { name: raw.toolChoice } };
    }

    const client = clientFor(target.value);
    const turns: ToolTurn[] = [];
    const offered = presets.map((p) => p.id);

    const first = await client.call(surface, body);
    store.add(first);
    turns.push(
      summariseTurn(1, 'request', first, readOutput(surfaceId, first.response?.body).text, surfaceId),
    );

    const calls = onResponses
      ? extractResponsesToolCalls(first.response?.body)
      : extractToolCalls(first.response?.body);
    const executed: Array<{ name: string; result: unknown }> = [];

    if (calls.length > 0) {
      // Echo the assistant turn back verbatim, then one tool message per call —
      // exactly the shape the OpenAI SDK builds.
      const assistantMessage = (() => {
        const b = first.response?.body;
        if (typeof b === 'object' && b !== null) {
          const choices = (b as { choices?: unknown }).choices;
          if (Array.isArray(choices) && typeof choices[0] === 'object' && choices[0] !== null) {
            return (choices[0] as { message?: unknown }).message;
          }
        }
        return undefined;
      })();
      if (!onResponses && assistantMessage !== undefined) messages.push(assistantMessage);

      for (const call of calls) {
        const preset = toolPresetById(call.name);
        const result = preset !== undefined ? preset.run(call.argumentsParsed) : { error: `no local implementation for ${call.name}` };
        executed.push({ name: call.name, result });
        if (!onResponses) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }

      // Responses carries the conversation as `input[]` items - the call and
      // its output as separate entries keyed by call_id - not as chat messages.
      // Echo the gateway's OWN output items back verbatim, then append the
      // results — which is what a real client does, and what the chat path
      // already does with the assistant message.
      //
      // Rebuilding the function_call item by hand instead dropped the `id` and
      // `status` the gateway had assigned, and the continuation was refused.
      // Reconstructing a payload the server just sent you is a way of testing
      // your own guess rather than the gateway.
      const priorOutput = ((): unknown[] => {
        const b = first.response?.body;
        if (typeof b !== 'object' || b === null) return [];
        const out = (b as { output?: unknown }).output;
        return Array.isArray(out) ? out : [];
      })();

      const followUp: Record<string, unknown> = onResponses
        ? {
            model,
            input: [
              // The EXPLICIT message form, not the shorthand `{role, content}`.
              //
              // Measured 2026-08-31: the shorthand is accepted when it is the
              // only input item, and silently dropped once the input also
              // carries tool items — after which the gateway sees the
              // conversation starting with a `function_call` and answers "A
              // conversation must start with a user message", which is exactly
              // what the request did contain. Using the explicit form is the
              // workaround; the scenario `responses-shorthand-continuation`
              // keeps the bug itself under test.
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: prompt }],
              },
              ...priorOutput,
              ...calls.map((c, i) => ({
                type: 'function_call_output',
                call_id: c.id,
                output: JSON.stringify(executed[i]?.result ?? {}),
              })),
            ],
            max_output_tokens: 256,
            tools: toolDefs,
          }
        : { model, messages, max_tokens: 256, tools: toolDefs };
      const second = await client.call(surface, followUp);
      store.add(second);
      turns.push(
        summariseTurn(
          2,
          'tool-results',
          second,
          readOutput(surfaceId, second.response?.body).text,
          surfaceId,
        ),
      );
    }

    const finalText = turns[turns.length - 1]?.text;
    const swallowed = calls.length === 0 && looksSwallowed(finalText, offered);

    app.log.info(
      `tool loop ${surfaceId} ${model} tools=[${offered.join(',')}] → ${calls.length} call(s), ${turns.length} turn(s)` +
        (useWrongShape ? ' [wrong tool shape]' : '') +
        (swallowed ? ' — SWALLOWED' : ''),
    );

    return {
      surfaceId,
      wrongToolShape: useWrongShape,
      turns,
      offered,
      executed,
      calledNothing: calls.length === 0,
      swallowed,
      finalText: finalText ?? null,
    };
  });

  /** The MCP surfaces this key can see. All free — no provider involved. */
  app.post<{ Body: McpBody }>('/api/mcp/browse', async (request, reply) => {
    const target = resolveTarget(request.body ?? {});
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const client = clientFor(target.value);
    const [servers, tools] = await Promise.all([client.mcpListServers(), client.mcpListTools()]);
    store.add(servers);
    store.add(tools);

    return {
      servers: {
        status: servers.response?.status ?? null,
        verdict: servers.verdict,
        parsed: readMcpServers(servers.response?.body),
        body: servers.response?.body ?? null,
        exchangeId: servers.id,
      },
      tools: {
        status: tools.response?.status ?? null,
        verdict: tools.verdict,
        parsed: readMcpTools(tools.response?.body),
        body: tools.response?.body ?? null,
        exchangeId: tools.id,
      },
    };
  });

  /**
   * Probe one registered server with its stored credential, server-side.
   *
   * The browser never sends the secret: the gateway holds it and dials out
   * itself. That also makes this the only honest answer to "is this server
   * actually reachable?", as opposed to "does the gateway list it", which it
   * will do either way.
   */
  app.post<{ Body: McpCallBody }>('/api/mcp/test', async (request, reply) => {
    const raw = request.body ?? {};
    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const server = typeof raw.server === 'string' ? raw.server : '';
    if (server.length === 0) {
      return reply.status(400).send({ error: 'A server id or name is required.' });
    }

    const exchange = await clientFor(target.value).mcpTestServer(server);
    store.add(exchange);
    return exchange;
  });

  /** Invoke one MCP tool directly, with no model in the loop. */
  app.post<{ Body: McpCallBody }>('/api/mcp/call', async (request, reply) => {
    const raw = request.body ?? {};
    const target = resolveTarget(raw);
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const server = typeof raw.server === 'string' ? raw.server : '';
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (server.length === 0 || name.length === 0) {
      return reply.status(400).send({ error: 'server and name are both required.' });
    }

    const exchange = await clientFor(target.value).mcpCallTool(server, name, raw.arguments ?? {});
    store.add(exchange);
    return exchange;
  });

  /** The Streamable-HTTP aggregate, as an off-the-shelf MCP client would speak it. */
  app.post<{ Body: TargetBody }>('/api/mcp/aggregate', async (request, reply) => {
    const target = resolveTarget(request.body ?? {});
    if (!target.ok) return reply.status(400).send({ error: target.error });

    const exchange = await clientFor(target.value).mcpAggregate({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    store.add(exchange);
    return exchange;
  });

  // ── Scenarios ──────────────────────────────────────────────────────────────

  app.get('/api/scenarios/suites', () =>
    SUITES.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      scenarios: s.scenarios.map((sc) => ({
        id: sc.id,
        title: sc.title,
        why: sc.why,
        surface: sc.surface,
        spends: sc.spends,
        reference: sc.reference ?? 'measured',
        ...(sc.landmine !== undefined ? { landmine: sc.landmine } : {}),
        ...(sc.notImplemented !== undefined ? { notImplemented: sc.notImplemented } : {}),
      })),
    })),
  );

  /**
   * Run a suite against one or more targets, streaming each result as it lands.
   *
   * Sequential on purpose, with an optional pace between calls. Running a suite
   * concurrently would finish sooner and tell you less: where a key does have an
   * RPM cap, a burst turns half the suite into 429s that have nothing to do with
   * the scenarios being asked.
   *
   * Two targets in one run is how the same suite becomes a comparison — the same
   * questions asked of local and prod, with the target named on every row.
   */
  app.post<{ Body: ScenarioRunBody }>('/api/scenarios/run', async (request, reply) => {
    const raw = request.body ?? {};

    const suite = suiteById(typeof raw.suiteId === 'string' ? raw.suiteId : '');
    if (suite === undefined) return reply.status(400).send({ error: 'Unknown suite' });

    const rawTargets = Array.isArray(raw.targets) ? raw.targets : [];
    if (rawTargets.length === 0) return reply.status(400).send({ error: 'Pick at least one target.' });

    const resolved: Array<{ label: string; target: ResolvedTarget }> = [];
    for (const entry of rawTargets) {
      const body = (typeof entry === 'object' && entry !== null ? entry : {}) as TargetBody & {
        label?: unknown;
      };
      const t = resolveTarget(body);
      if (!t.ok) return reply.status(400).send({ error: t.error });
      const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : t.value.profile.label;
      resolved.push({ label, target: t.value });
    }

    const ctx = {
      model: typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : 'bedrock-nova-micro',
      embedModel:
        typeof raw.embedModel === 'string' && raw.embedModel.length > 0
          ? raw.embedModel
          : 'bedrock-titan-embed-v2',
    };
    const paceMs = typeof raw.paceMs === 'number' ? Math.min(Math.max(raw.paceMs, 0), 5000) : 0;
    const includeSpending = raw.includeSpending !== false;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event: string, data: unknown): void => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let cancelled = false;
    res.on('close', () => {
      cancelled = true;
    });

    const scenarios = suite.scenarios.filter((s) => includeSpending || !s.spends);
    const results: ScenarioResult[] = [];
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    emit('start', {
      suiteId: suite.id,
      total: scenarios.length * resolved.length,
      skippedSpending: suite.scenarios.length - scenarios.length,
    });

    try {
      for (const { label, target } of resolved) {
        for (const scenario of scenarios) {
          if (cancelled) break;

          const surface = surfaceById(scenario.surface);
          if (surface === undefined) continue;

          // `unauthenticated` overrides the target's key for this one call —
          // the front-door check has to be able to arrive without a credential.
          const client = new TokenShieldClient({
            profile: target.profile,
            keyAlias: scenario.unauthenticated === true ? null : target.keyAlias,
            secret: scenario.unauthenticated === true ? null : target.secret,
            scheme: scenario.unauthenticated === true ? 'none' : target.scheme,
            timeoutMs: config.timeoutMs,
          });

          const exchange = await client.call(surface, scenario.body(ctx));
          store.add(exchange);
          const result = evaluateScenario(scenario, suite.id, exchange, label);
          results.push(result);
          emit('result', result);

          if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
        }
      }

      const report: ScenarioReport = {
        suiteId: suite.id,
        suiteTitle: suite.title,
        startedAt,
        durationMs: Date.now() - t0,
        model: ctx.model,
        embedModel: ctx.embedModel,
        targets: resolved.map((r) => ({
          label: r.label,
          baseUrl: r.target.profile.baseUrl,
          keyAlias: r.target.keyAlias,
        })),
        results,
        tally: tally(results),
      };
      lastReport = report;

      app.log.info(
        `suite ${suite.id} on ${resolved.map((r) => r.label).join(' + ')} → ` +
          Object.entries(report.tally)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}:${n}`)
            .join(' '),
      );
      emit('done', report);
    } catch (error) {
      emit('error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /**
   * Write the last report to `out/`.
   *
   * The only disk write this tool performs that is not `.env.local`, and it
   * happens because someone pressed a button — see AD-03. JSON for machines,
   * Markdown for a ticket.
   */
  app.post('/api/scenarios/export', async (_request, reply) => {
    if (lastReport === null) return reply.status(400).send({ error: 'Nothing to export yet.' });

    const outDir = resolve(REPO_ROOT, 'out');
    await mkdir(outDir, { recursive: true });
    const stamp = lastReport.startedAt.replace(/[:.]/g, '-');
    const base = `${lastReport.suiteId}-${stamp}`;
    const jsonPath = resolve(outDir, `${base}.json`);
    const mdPath = resolve(outDir, `${base}.md`);

    await writeFile(jsonPath, JSON.stringify(lastReport, null, 2), 'utf8');
    await writeFile(mdPath, reportToMarkdown(lastReport), 'utf8');

    app.log.info(`exported ${base}.json and .md`);
    return { jsonPath, mdPath };
  });

  // ── History ────────────────────────────────────────────────────────────────

  /**
   * History, newest first. Summaries only — the full exchange is fetched by id.
   *
   * Always bounded: an explicit `limit`, else a default page. The ring buffer
   * caps the total anyway, but a list endpoint that returns "everything" by
   * default is the shape that stops being fine the moment someone raises the
   * cap (BP-007, BP-103).
   */
  const DEFAULT_RUN_PAGE = 50;
  const MAX_RUN_PAGE = 200;

  app.get<{ Querystring: { limit?: string } }>('/api/runs', (request) => {
    const raw = request.query.limit;
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_RUN_PAGE) : DEFAULT_RUN_PAGE;
    return {
      total: store.size,
      capacity: store.capacity,
      limit,
      exchanges: store.list(limit),
    };
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
