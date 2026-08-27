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
            ? `${models.length} model${models.length === 1 ? '' : 's'} allowed for this key`
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
    exchanges,
  };
}
