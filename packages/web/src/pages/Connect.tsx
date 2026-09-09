import { useMemo, useState } from 'react';

import type { AuthScheme, McpEntitlement } from '@tokenshield/client';

import type { LabConfigResponse, PreflightResponse } from '../api';
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
}

export function Connect(props: ConnectProps) {
  const { config, result } = props;
  const [modelFilter, setModelFilter] = useState('');

  // `mcp` is `unknown` on PreflightResult to keep types.ts free of an import
  // cycle (mcp.ts already imports from types.ts), so it is narrowed here — the
  // same treatment `metrics` gets.
  const mcp = result?.mcp as McpEntitlement | undefined;

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
        activeProfileId={props.profileId}
        activeKeyAlias={props.keyAlias}
        onProfile={props.onProfile}
        onKey={props.onKey}
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
            <StatusPill
              status={result.ok ? 'pass' : 'fail'}
              label={result.ok ? 'ready' : 'blocked'}
            />
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
          subtitle="From GET /v1/models. Whether this is the key’s allowedModels or the whole org catalogue is UNVERIFIED — 53 models came back for a $2 test key, and LiteLLM returns only what its key can reach. See FINDINGS.md #13."
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

      {mcp !== undefined && (
        <Card
          title="MCP servers and tools for this key"
          subtitle="GET /v1/mcp/servers — live on every call, not the 60s cache, so this is the authoritative view"
        >
          <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
            {mcp.usable} usable
            {mcp.totals.block > 0 && <> · {mcp.totals.block} blocked</>}
            {mcp.totals.ask > 0 && (
              <>
                {' '}
                · {mcp.totals.ask} marked <code className="mono">ask</code>
              </>
            )}{' '}
            across {mcp.servers.length} server{mcp.servers.length === 1 ? '' : 's'}. A blocked tool
            is <strong>withheld from the model entirely</strong> rather than refused, so this list —
            not the model&rsquo;s answer — is what proves a policy is in force.
          </p>

          <div className="space-y-3">
            {mcp.servers.map((server) => (
              <div
                key={server.id ?? server.name}
                className="rounded border border-zinc-800 bg-zinc-900/40 p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-xs font-medium text-zinc-200">{server.name}</span>
                  {server.id !== undefined && (
                    <code className="mono text-[10px] text-zinc-600">{server.id}</code>
                  )}
                  <span className="mono text-[10px] text-zinc-600">
                    {server.tools.length} tool{server.tools.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="mt-2 space-y-1">
                  {server.tools.map((tool) => (
                    <div key={tool.name} className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`mono rounded px-1 text-[10px] ${
                          tool.policy === 'block'
                            ? 'bg-rose-500/10 text-rose-300'
                            : tool.policy === 'ask'
                              ? 'bg-amber-500/10 text-amber-300'
                              : 'bg-emerald-500/10 text-emerald-300'
                        }`}
                      >
                        {tool.policy}
                      </span>
                      <span className="mono text-[11px] text-zinc-300">{tool.name}</span>
                      {/*
                        The wire name is DERIVED, not reported — it appears in no
                        API response, yet it is the only name the model sees and
                        the only one a forced-call test can use.
                      */}
                      {tool.wire.name !== undefined ? (
                        <code className="mono text-[10px] text-sky-400/70">{tool.wire.name}</code>
                      ) : (
                        <span className="text-[10px] text-zinc-600" title={tool.wire.note}>
                          wire name not derivable
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 text-[10px] leading-relaxed text-zinc-600">
            The blue name is the <strong>wire name</strong> — what the model is shown, and what a
            refusal names. It is derived from the server name here because no
            <em> listing </em> returns it: both MCP endpoints, the{' '}
            <code className="mono">mcp_list_tools</code> item and{' '}
            <code className="mono">mcp_call</code> all report the upstream name. It does reach
            clients on the tool-call path though — a mixed turn returned{' '}
            <code className="mono">huggingface__hub_repo_search</code> in{' '}
            <code className="mono">tool_calls</code>, which is FINDINGS.md #9. Use it to force a
            call to a blocked tool and see whether the refusal is{' '}
            <code className="mono">policy_block</code> rather than{' '}
            <code className="mono">unknown_tool</code>.
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
    </div>
  );
}
