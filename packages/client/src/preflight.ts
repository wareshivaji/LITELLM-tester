/**
 * Preflight — "can I actually use this gateway with this key, right now?"
 *
 * Five checks, none of which call a provider, so preflight is free to run as
 * often as you like: liveness, the Claude connectivity probe, auth + the key's
 * model catalogue, and the gateway's metrics snapshot.
 *
 * If the gateway is unreachable the remaining checks are skipped rather than
 * left to time out one by one — a wrong base URL should fail in a second, not
 * in a minute.
 */

import { extractModels, TokenShieldClient } from './client.js';
import { readMcpServers, tallyPolicies, withWireNames } from './mcp.js';
import type { McpServerWithWires } from './mcp.js';
import { surfaceById } from './surfaces.js';
import type { CheckStatus, Exchange, ModelInfo, PreflightCheck, PreflightResult } from './types.js';

const PREFLIGHT_TIMEOUT_MS = 10_000;

interface CheckSeed {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  exchange?: Exchange;
}

function toCheck(seed: CheckSeed): PreflightCheck {
  const check: PreflightCheck = {
    id: seed.id,
    label: seed.label,
    status: seed.status,
    detail: seed.detail,
  };
  if (seed.exchange !== undefined) {
    check.exchangeId = seed.exchange.id;
    check.latencyMs = seed.exchange.timings.totalMs;
  }
  return check;
}

function healthDetail(exchange: Exchange): CheckSeed {
  if (exchange.transportError !== undefined) {
    return {
      id: 'reachable',
      label: 'Gateway reachable',
      status: 'fail',
      detail: exchange.transportError,
      exchange,
    };
  }
  const status = exchange.response?.status ?? 0;
  const body = exchange.response?.body as { status?: string; service?: string } | undefined;
  if (status === 200 && body?.status === 'healthy') {
    return {
      id: 'reachable',
      label: 'Gateway reachable',
      status: 'pass',
      detail: `${body.service ?? 'gateway'} reported healthy in ${exchange.timings.totalMs}ms`,
      exchange,
    };
  }
  if (status === 200) {
    return {
      id: 'reachable',
      label: 'Gateway reachable',
      status: 'warn',
      detail: 'Answered 200 but not the expected {status:"healthy"} body',
      exchange,
    };
  }
  return {
    id: 'reachable',
    label: 'Gateway reachable',
    status: 'fail',
    detail: `/health answered ${status}`,
    exchange,
  };
}

export interface PreflightOptions {
  /** Skip the authenticated checks when no key is selected. */
  hasKey: boolean;
  timeoutMs?: number;
}

/**
 * What MCP this key may reach, with each tool's wire name.
 *
 * The wire name is derived rather than reported — it appears in no API
 * response, yet it is the only name the model sees and the only one a
 * forced-call test can use. See `wireNameFor`.
 */
export interface McpEntitlement {
  servers: McpServerWithWires[];
  totals: { allow: number; block: number; ask: number; unknown: number };
  /** Tools actually usable — the number that decides whether this works. */
  usable: number;
}

export async function runPreflight(
  client: TokenShieldClient,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const timeout = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const exchanges: Exchange[] = [];
  const seeds: CheckSeed[] = [];
  let models: ModelInfo[] = [];
  let metrics: unknown;
  let mcp: McpEntitlement | undefined;

  const health = await client.health(timeout);
  exchanges.push(health);
  const healthSeed = healthDetail(health);
  seeds.push(healthSeed);

  const unreachable = health.transportError !== undefined;
  const skip = (id: string, label: string, reason: string): CheckSeed => ({
    id,
    label,
    status: 'skip',
    detail: `Skipped — ${reason}`,
  });
  const NO_GATEWAY = 'the gateway did not answer /health';
  const NO_KEY = 'no key selected';

  if (unreachable) {
    seeds.push(skip('probe', 'Connectivity probe (HEAD /)', NO_GATEWAY));
    seeds.push(skip('auth', 'Key accepted', NO_GATEWAY));
    seeds.push(skip('catalog', 'Models available to this key', NO_GATEWAY));
    seeds.push(skip('metrics', 'Gateway metrics', NO_GATEWAY));
    seeds.push(skip('mcp', 'MCP servers and tools for this key', NO_GATEWAY));
  } else {
    const [probe, modelsExchange, metricsExchange] = await Promise.all([
      client.probeRoot(timeout),
      options.hasKey ? client.listModels(timeout) : Promise.resolve(null),
      client.metrics(timeout),
    ]);

    exchanges.push(probe);
    seeds.push({
      id: 'probe',
      label: 'Connectivity probe (HEAD /)',
      status: probe.response?.status === 200 ? 'pass' : 'warn',
      detail:
        probe.response?.status === 200
          ? 'Answers the startup probe Claude clients send'
          : `Answered ${probe.response?.status ?? 'nothing'} — clients tolerate this, it only shows up in gateway logs`,
      exchange: probe,
    });

    if (modelsExchange === null) {
      seeds.push({
        id: 'auth',
        label: 'Key accepted',
        status: 'skip',
        detail: 'Skipped — no key selected. Pick one to test authentication.',
      });
      seeds.push(skip('catalog', 'Models available to this key', NO_KEY));
    } else {
      exchanges.push(modelsExchange);
      const ok = modelsExchange.verdict.kind === 'ok';
      models = ok ? extractModels(modelsExchange.response?.body) : [];
      seeds.push({
        id: 'auth',
        label: 'Key accepted',
        status: ok ? 'pass' : 'fail',
        detail: ok
          ? `Authenticated as ${modelsExchange.gateway.organizationId ?? 'this org'} via ${modelsExchange.authScheme}`
          : `${modelsExchange.verdict.kind}: ${modelsExchange.verdict.detail}`,
        exchange: modelsExchange,
      });
      seeds.push({
        id: 'catalog',
        label: 'Models available to this key',
        status: !ok ? 'skip' : models.length > 0 ? 'pass' : 'warn',
        detail: !ok
          ? 'Skipped — the key was not accepted'
          : models.length > 0
            ? `${models.length} model${models.length === 1 ? '' : 's'} returned (key-filtered or org catalogue: unverified)`
            : 'Key authenticated but no models are allowed for it',
        ...(ok ? { exchange: modelsExchange } : {}),
      });
    }

    exchanges.push(metricsExchange);
    const metricsOk = metricsExchange.response?.status === 200;
    if (metricsOk) metrics = metricsExchange.response?.body;
    seeds.push({
      id: 'metrics',
      label: 'Gateway metrics',
      status: metricsOk ? 'pass' : 'warn',
      detail: metricsOk
        ? 'Snapshot readable — RPM and counters available'
        : `/api/v1/metrics answered ${metricsExchange.response?.status ?? 'nothing'}`,
      exchange: metricsExchange,
    });

    // ── 6. MCP entitlement ────────────────────────────────────────────────
    // Free: GET /v1/mcp/servers generates nothing. Worth having on Connect
    // because "can I use this key" includes what tools it may reach, and that
    // was previously only visible on another page.
    //
    // This endpoint also goes LIVE on every call rather than reading the 60s
    // cache, so it is the authoritative view — unlike the brokered
    // `mcp_list_tools` item, which only appears when a tool actually runs and
    // so cannot be relied on to answer "what does this key have".
    if (!options.hasKey) {
      seeds.push(skip('mcp', 'MCP servers and tools for this key', NO_KEY));
    } else {
      const surface = surfaceById('mcp.servers');
      if (surface === undefined) {
        seeds.push(skip('mcp', 'MCP servers and tools for this key', 'Surface not registered'));
      } else {
        const mcpExchange = await client.call(surface, undefined, timeout);
        exchanges.push(mcpExchange);
        const mcpOk = mcpExchange.response?.status === 200;
        const servers = mcpOk ? readMcpServers(mcpExchange.response?.body) : [];
        const withWire = withWireNames(servers);
        const allTools = servers.flatMap((sv) => sv.tools);
        const tally = tallyPolicies(allTools);

        if (mcpOk) {
          mcp = {
            servers: withWire,
            totals: tally,
            // A key with entitlement but zero usable tools is worth calling
            // out on its own: the integration will look broken to whoever
            // configured it, and nothing else in the console says why.
            usable: tally.allow,
          };
        }

        seeds.push({
          id: 'mcp',
          label: 'MCP servers and tools for this key',
          status: !mcpOk
            ? 'warn'
            : servers.length === 0
              ? 'warn'
              : tally.allow === 0
                ? 'warn'
                : 'pass',
          detail: !mcpOk
            ? // Report the CAUSE, not the absence. "answered nothing" hides a
              // transport error behind a phrase that reads like the gateway
              // replied emptily — the third time this same mistake has been
              // made here, so the transport error now comes first.
              (mcpExchange.transportError ??
              `/v1/mcp/servers answered ${mcpExchange.response?.status ?? 'no response'}`)
            : servers.length === 0
              ? 'No MCP servers for this key. Note this endpoint cannot distinguish "none configured" from "discovery failed"'
              : tally.allow === 0
                ? `${servers.length} server(s) reachable but every tool is blocked — the integration will look broken`
                : `${String(tally.allow)} tool${tally.allow === 1 ? '' : 's'} usable across ${String(servers.length)} server${servers.length === 1 ? '' : 's'}` +
                  (tally.block > 0 ? `, ${String(tally.block)} blocked` : '') +
                  (tally.ask > 0 ? `, ${String(tally.ask)} marked "ask" (unenforceable)` : ''),
          exchange: mcpExchange,
        });
      }
    }
  }

  const checks = seeds.map(toCheck);
  return {
    profile: client.transport.activeProfile,
    keyAlias: options.hasKey ? client.transport.selectedKeyAlias : null,
    authScheme: exchanges.find((e) => e.keyAlias !== null)?.authScheme ?? 'none',
    startedAt,
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
    models,
    ...(metrics !== undefined ? { metrics } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    exchanges,
  };
}
