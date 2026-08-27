import { useCallback, useEffect, useState } from 'react';

import type { AuthScheme, ExchangeSummary } from '@tokenshield/client';

import { api } from './api';
import type { LabConfigResponse, PreflightResponse } from './api';
import { Connect } from './pages/Connect';

/**
 * The seven pages of the lab. Everything past Connect is a later phase —
 * shown, not hidden, so the shape of the tool is visible from day one.
 */
const NAV: ReadonlyArray<{ id: string; label: string; phase: number }> = [
  { id: 'connect', label: 'Connect', phase: 1 },
  { id: 'playground', label: 'Playground', phase: 2 },
  { id: 'streaming', label: 'Streaming', phase: 3 },
  { id: 'sdk-compare', label: 'SDK compare', phase: 4 },
  { id: 'governance', label: 'Governance', phase: 5 },
  { id: 'tools', label: 'Tools & MCP', phase: 6 },
  { id: 'scenarios', label: 'Scenarios', phase: 7 },
];

const CURRENT_PHASE = 1;

export function App() {
  const [config, setConfig] = useState<LabConfigResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [profileId, setProfileId] = useState('');
  const [keyAlias, setKeyAlias] = useState<string | null>(null);
  const [scheme, setScheme] = useState<AuthScheme>('bearer');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<ExchangeSummary[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsCapacity, setRunsCapacity] = useState(0);

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        setProfileId(cfg.defaults.profileId);
        setKeyAlias(cfg.defaults.keyAlias);
        setRunsCapacity(cfg.historyLimit);
      })
      .catch((err: unknown) => {
        setBootError(
          err instanceof Error
            ? `${err.message} — is the lab server running? (npm run dev)`
            : String(err),
        );
      });
  }, []);

  const refreshRuns = useCallback(() => {
    api
      .runs()
      .then((r) => {
        setRuns(r.exchanges);
        setRunsTotal(r.total);
        setRunsCapacity(r.capacity);
      })
      .catch(() => {
        /* the log is a convenience; a failed refresh must not break the page */
      });
  }, []);

  useEffect(() => refreshRuns(), [refreshRuns]);

  const runPreflight = useCallback(() => {
    setRunning(true);
    setError(null);
    api
      .preflight({ profileId, keyAlias, scheme })
      .then((res) => setResult(res))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setRunning(false);
        refreshRuns();
      });
  }, [profileId, keyAlias, scheme, refreshRuns]);

  if (bootError !== null) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-lg border border-rose-900/60 bg-rose-950/20 p-6">
          <h1 className="text-sm font-semibold text-rose-200">Lab server unreachable</h1>
          <p className="mt-2 text-sm text-rose-300/80">{bootError}</p>
        </div>
      </div>
    );
  }

  if (config === null) {
    return <div className="p-8 text-sm text-zinc-500">Loading lab configuration…</div>;
  }

  const profile = config.profiles.find((p) => p.id === profileId);
  const maskedKey = config.keys.find((k) => k.alias === keyAlias)?.masked;

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="text-sm font-semibold text-zinc-100">TokenShield Lab</div>
          <div className="mt-0.5 text-[11px] text-zinc-600">client SDK · console</div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {NAV.map((item) => {
            const enabled = item.phase <= CURRENT_PHASE;
            return (
              <div
                key={item.id}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                  enabled
                    ? 'bg-zinc-900 text-zinc-100'
                    : 'cursor-not-allowed text-zinc-600'
                }`}
              >
                <span>{item.label}</span>
                {!enabled && (
                  <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-600">
                    P{item.phase}
                  </span>
                )}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800 p-3 text-[10px] leading-relaxed text-zinc-600">
          No database. History lives in the server’s memory and is discarded on restart.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The target strip. Always visible, on every page, because the most
          expensive recurring bug in this workspace has been "which gateway
          did that run actually hit?".
        */}
        <header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/80 px-6 py-2.5 text-xs">
          <span className="text-zinc-600">target</span>
          <span className="rounded bg-zinc-900 px-2 py-0.5 text-zinc-200">
            {profile?.label ?? profileId}
          </span>
          <span className="mono text-zinc-400">{profile?.baseUrl ?? '—'}</span>
          <span className="text-zinc-700">|</span>
          <span className="text-zinc-600">key</span>
          <span className="mono text-zinc-300">{keyAlias ?? 'none'}</span>
          {maskedKey !== undefined && <span className="mono text-zinc-600">{maskedKey}</span>}
          <span className="mono ml-auto text-zinc-600">{scheme}</span>
        </header>

        <main className="min-h-0 flex-1 overflow-auto p-6">
          <Connect
            config={config}
            profileId={profileId}
            keyAlias={keyAlias}
            scheme={scheme}
            onProfile={setProfileId}
            onKey={setKeyAlias}
            onScheme={setScheme}
            onRun={runPreflight}
            running={running}
            result={result}
            error={error}
            runs={runs}
            runsTotal={runsTotal}
            runsCapacity={runsCapacity}
            onRefreshRuns={refreshRuns}
          />
        </main>
      </div>
    </div>
  );
}
