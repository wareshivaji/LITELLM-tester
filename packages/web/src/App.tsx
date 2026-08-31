import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AuthScheme, ExchangeSummary } from '@tokenshield/client';

import { api } from './api';
import type { LabConfigResponse, PreflightResponse } from './api';
import { ExchangeLog } from './components/ExchangeLog';
import { TargetBar } from './components/TargetBar';
import { Notice } from './components/ui';
import { useModelCatalogue } from './hooks/useModelCatalogue';
import { Connect } from './pages/Connect';
import { Governance } from './pages/Governance';
import { Playground } from './pages/Playground';
import { Scenarios } from './pages/Scenarios';
import { SdkCompare } from './pages/SdkCompare';
import { Streaming } from './pages/Streaming';
import { ToolsMcp } from './pages/ToolsMcp';

/**
 * The seven pages, grouped by what you are trying to do rather than listed
 * flat. A first-time reader should be able to tell where to start, and what the
 * tool is for, from the sidebar alone.
 *
 * The amber dot marks a page that can reach a provider, so cost is visible
 * before clicking rather than discovered afterwards.
 */
const NAV: ReadonlyArray<{
  section: string;
  items: Array<{ id: string; label: string; blurb: string; spends: boolean }>;
}> = [
  {
    section: 'Set up',
    items: [
      { id: 'connect', label: 'Connect', blurb: 'Can I reach this gateway?', spends: false },
    ],
  },
  {
    section: 'Send',
    items: [
      { id: 'playground', label: 'Playground', blurb: 'One request, eight surfaces', spends: true },
      { id: 'streaming', label: 'Streaming', blurb: 'A response over time', spends: true },
      { id: 'sdk-compare', label: 'SDK compare', blurb: 'What a real SDK reports', spends: true },
    ],
  },
  {
    section: 'Govern',
    items: [
      { id: 'governance', label: 'Governance', blurb: 'Mint keys, trip the gates', spends: true },
      { id: 'tools', label: 'Tools & MCP', blurb: 'Tool loops, MCP entitlement', spends: true },
    ],
  },
  {
    section: 'Verify',
    items: [
      { id: 'scenarios', label: 'Scenarios', blurb: 'Suites, compare, reports', spends: true },
    ],
  },
];

export function App() {
  const [config, setConfig] = useState<LabConfigResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [page, setPage] = useState('connect');
  const [logOpen, setLogOpen] = useState(false);

  const [profileId, setProfileId] = useState('');
  const [keyAlias, setKeyAlias] = useState<string | null>(null);
  const [scheme, setScheme] = useState<AuthScheme>('bearer');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<ExchangeSummary[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsCapacity, setRunsCapacity] = useState(0);

  const target = useMemo(() => ({ profileId, keyAlias, scheme }), [profileId, keyAlias, scheme]);
  const catalogue = useModelCatalogue(target);

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
            ? `${err.message} — is the lab server running?`
            : String(err),
        );
      });
  }, []);

  /**
   * Refetch after a session target was added or removed. Selection is
   * re-validated here rather than in the picker: removing the selected key
   * would otherwise leave the target bar naming something that no longer
   * exists, and the next call would 400 on an alias the UI still shows.
   */
  const refreshConfig = useCallback(() => {
    api
      .config()
      .then((cfg) => {
        setConfig(cfg);
        setRunsCapacity(cfg.historyLimit);
        setProfileId((current) =>
          cfg.profiles.some((p) => p.id === current) ? current : cfg.defaults.profileId,
        );
        setKeyAlias((current) =>
          current === null || cfg.keys.some((k) => k.alias === current)
            ? current
            : cfg.defaults.keyAlias,
        );
      })
      .catch(() => {
        /* transient — the page keeps working with the config it already has */
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
          <pre className="mono mt-3 rounded bg-zinc-950 p-2 text-xs text-zinc-400">npm run dev</pre>
        </div>
      </div>
    );
  }

  if (config === null) {
    return <div className="p-8 text-sm text-zinc-500">Loading lab configuration…</div>;
  }

  const hasApiKey = config.keys.some((k) => k.kind === 'api');
  const pageProps = { profileId, keyAlias, scheme, onRecorded: refreshRuns };

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-4">
          <div className="text-sm font-semibold text-zinc-100">TokenShield Lab</div>
          <div className="mt-0.5 text-[11px] text-zinc-600">be the customer, see everything</div>
        </div>

        <nav className="flex-1 overflow-auto p-2">
          {NAV.map((group) => (
            <div key={group.section} className="mb-3">
              <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
                {group.section}
              </div>
              {group.items.map((item) => {
                const active = item.id === page;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPage(item.id)}
                    className={`flex w-full flex-col rounded-md px-3 py-1.5 text-left ${
                      active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={`text-sm ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                        {item.label}
                      </span>
                      {item.spends && (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-amber-500/70"
                          title="This page can reach a provider — real tokens"
                        />
                      )}
                    </span>
                    <span className="text-[10px] leading-tight text-zinc-600">{item.blurb}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-zinc-800 p-3 text-[10px] leading-relaxed text-zinc-600">
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500/70 align-middle" />
          can spend · no database, history is in memory
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TargetBar
          profiles={config.profiles}
          keys={config.keys}
          profileId={profileId}
          keyAlias={keyAlias}
          scheme={scheme}
          onProfile={setProfileId}
          onKey={setKeyAlias}
          onScheme={setScheme}
          logCount={runsTotal}
          logOpen={logOpen}
          onToggleLog={() => setLogOpen((o) => !o)}
        />

        <main className="min-h-0 flex-1 space-y-5 overflow-auto p-6">
          {!hasApiKey && (
            <Notice tone="warn" title="No API key configured">
              <p>
                Nothing here can talk to a gateway yet. Add a key on <strong>Connect</strong> with{' '}
                <span className="mono">+ add</span>, or put{' '}
                <span className="mono">TSLAB_KEY_&lt;ALIAS&gt;=cg-ak-…</span> in{' '}
                <span className="mono">.env.local</span> and restart the backend.
              </p>
            </Notice>
          )}
          {hasApiKey && keyAlias === null && (
            <Notice tone="info" title="No key selected">
              <p>Pick one in the bar above — the gateway will refuse everything until you do.</p>
            </Notice>
          )}

          {page === 'playground' ? (
            <Playground {...pageProps} catalogue={catalogue} />
          ) : page === 'streaming' ? (
            <Streaming {...pageProps} catalogue={catalogue} />
          ) : page === 'sdk-compare' ? (
            <SdkCompare {...pageProps} catalogue={catalogue} />
          ) : page === 'scenarios' ? (
            <Scenarios {...pageProps} config={config} catalogue={catalogue} />
          ) : page === 'tools' ? (
            <ToolsMcp {...pageProps} catalogue={catalogue} />
          ) : page === 'governance' ? (
            <Governance
              {...pageProps}
              keys={config.keys}
              onTargetsChanged={refreshConfig}
              onKey={setKeyAlias}
            />
          ) : (
            <Connect
              config={config}
              profileId={profileId}
              keyAlias={keyAlias}
              scheme={scheme}
              onProfile={setProfileId}
              onKey={setKeyAlias}
              onScheme={setScheme}
              onTargetsChanged={refreshConfig}
              onRun={runPreflight}
              running={running}
              result={result}
              error={error}
            />
          )}
        </main>

        {/*
          The log is a drawer, not a page section. It used to sit at the bottom
          of every page, always open, pushing the actual work down the screen —
          and it is reference material you consult, not content you read.
        */}
        {logOpen && (
          <div className="max-h-[45vh] shrink-0 overflow-auto border-t border-zinc-800 bg-zinc-950/60 p-4">
            <ExchangeLog
              runs={runs}
              total={runsTotal}
              capacity={runsCapacity}
              onRefresh={refreshRuns}
            />
          </div>
        )}
      </div>
    </div>
  );
}
