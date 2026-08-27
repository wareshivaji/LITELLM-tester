import { useMemo, useState } from 'react';

import type { AuthScheme, ExchangeSummary } from '@tokenshield/client';

import type { LabConfigResponse, PreflightResponse } from '../api';
import { ExchangeLog } from '../components/ExchangeLog';
import { TargetPicker } from '../components/TargetPicker';
import { Card, Empty, Json, StatusPill } from '../components/ui';

interface ConnectProps {
  config: LabConfigResponse;
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onProfile: (id: string) => void;
  onKey: (alias: string | null) => void;
  onScheme: (scheme: AuthScheme) => void;
  onTargetsChanged: () => void;
  onRun: () => void;
  running: boolean;
  result: PreflightResponse | null;
  error: string | null;
  runs: ExchangeSummary[];
  runsTotal: number;
  runsCapacity: number;
  onRefreshRuns: () => void;
}

export function Connect(props: ConnectProps) {
  const { config, result } = props;
  const [modelFilter, setModelFilter] = useState('');

  const models = useMemo(() => {
    const all = result?.models ?? [];
    const needle = modelFilter.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        (m.display_name ?? '').toLowerCase().includes(needle),
    );
  }, [result, modelFilter]);

  return (
    <div className="space-y-5">
      {config.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
            Configuration
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-amber-200/90">
            {config.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
          <p className="mono mt-2 text-xs text-amber-200/50">{config.envFile}</p>
        </div>
      )}

      <TargetPicker
        profiles={config.profiles}
        keys={config.keys}
        profileId={props.profileId}
        keyAlias={props.keyAlias}
        scheme={props.scheme}
        onProfile={props.onProfile}
        onKey={props.onKey}
        onScheme={props.onScheme}
        onTargetsChanged={props.onTargetsChanged}
        onRun={props.onRun}
        running={props.running}
        runError={props.error}
      />

      <Card
        title="Preflight"
        subtitle={
          result !== null
            ? `${result.profile.label} · ${result.profile.baseUrl} · key ${result.keyAlias ?? 'none'} · ${result.durationMs} ms`
            : 'Not run yet'
        }
        right={
          result !== null ? (
            <StatusPill status={result.ok ? 'pass' : 'fail'} label={result.ok ? 'ready' : 'blocked'} />
          ) : undefined
        }
      >
        {result === null ? (
          <Empty>Run a preflight to check reachability, auth and the key’s model catalogue.</Empty>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {result.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="w-20 shrink-0 pt-0.5">
                  <StatusPill status={check.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-200">{check.label}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{check.detail}</div>
                </div>
                {check.latencyMs !== undefined && (
                  <div className="mono shrink-0 text-xs text-zinc-600">{check.latencyMs} ms</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {result !== null && result.models.length > 0 && (
        <Card
          title="Models allowed for this key"
          subtitle="From GET /v1/models — the gateway filters this list by the key’s allowedModels."
          right={
            <input
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="filter…"
              className="mono w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-600"
            />
          }
        >
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <div
                key={m.id}
                className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5"
              >
                <div className="mono truncate text-xs text-zinc-200" title={m.id}>
                  {m.id}
                </div>
                {(m.display_name !== undefined || m.anthropic_family_tier !== undefined) && (
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
                    {m.display_name !== undefined && <span>{m.display_name}</span>}
                    {m.anthropic_family_tier !== undefined && (
                      <span className="rounded bg-violet-500/10 px-1 text-violet-300">
                        {m.anthropic_family_tier}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-600">
            {models.length} of {result.models.length} shown
          </p>
        </Card>
      )}

      {result?.metrics !== undefined && (
        <Card
          title="Gateway metrics"
          subtitle="GET /api/v1/metrics — the gateway's in-process counters"
        >
          <Json value={result.metrics} maxHeight={240} />
        </Card>
      )}

      <ExchangeLog
        runs={props.runs}
        total={props.runsTotal}
        capacity={props.runsCapacity}
        onRefresh={props.onRefreshRuns}
      />
    </div>
  );
}
