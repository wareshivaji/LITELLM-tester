import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { SUITES } from '@tokenshield/client';
import type {
  AuthScheme,
  Exchange,
  ScenarioOutcome,
  ScenarioReport,
  ScenarioResult,
} from '@tokenshield/client';

import { api } from '../api';
import type { LabConfigResponse } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { Card, Empty, selectClass, StatusPill } from '../components/ui';
import type { ModelCatalogue } from '../hooks/useModelCatalogue';
import type { CheckStatusLike } from '../components/ui';

const OUTCOME_TONE: Record<ScenarioOutcome, CheckStatusLike> = {
  pass: 'pass',
  fail: 'fail',
  'landmine-present': 'warn',
  'landmine-changed': 'warn',
  'not-implemented': 'skip',
  inconclusive: 'skip',
  error: 'fail',
};

const OUTCOME_LABEL: Record<ScenarioOutcome, string> = {
  pass: 'pass',
  fail: 'FAIL',
  'landmine-present': 'landmine',
  'landmine-changed': 'CHANGED',
  'not-implemented': 'not yet',
  inconclusive: 'blocked',
  error: 'error',
};

interface ScenariosProps {
  config: LabConfigResponse;
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
  catalogue: ModelCatalogue;
}

export function Scenarios(props: ScenariosProps) {
  const [suiteId, setSuiteId] = useState(SUITES[0]?.id ?? '');
  const suite = useMemo(() => SUITES.find((s) => s.id === suiteId) ?? SUITES[0], [suiteId]);
  const pendingCount =
    suite?.scenarios.filter((sc) => sc.notImplemented !== undefined).length ?? 0;

  const [secondProfile, setSecondProfile] = useState('');
  const models = props.catalogue.models;
  const [model, setModel] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [includeSpending, setIncludeSpending] = useState(true);
  const [paceMs, setPaceMs] = useState(0);

  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<ScenarioResult[]>([]);
  const [total, setTotal] = useState(0);
  const [report, setReport] = useState<ScenarioReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Defaults come from the shared catalogue, which distinguishes chat models
  // from embedding models so each picker starts on something plausible.
  useEffect(() => {
    setModel((cur) => (models.some((m) => m.id === cur) ? cur : props.catalogue.defaultModel));
    setEmbedModel((cur) =>
      models.some((m) => m.id === cur) ? cur : props.catalogue.defaultEmbedModel,
    );
  }, [models, props.catalogue.defaultModel, props.catalogue.defaultEmbedModel]);

  function run(): void {
    if (suite === undefined) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setLive([]);
    setReport(null);
    setError(null);
    setExported(null);

    const targets = [
      {
        profileId: props.profileId,
        keyAlias: props.keyAlias,
        scheme: props.scheme,
        label: props.config.profiles.find((p) => p.id === props.profileId)?.label ?? props.profileId,
      },
    ];
    if (secondProfile.length > 0 && secondProfile !== props.profileId) {
      targets.push({
        profileId: secondProfile,
        keyAlias: props.keyAlias,
        scheme: props.scheme,
        label: props.config.profiles.find((p) => p.id === secondProfile)?.label ?? secondProfile,
      });
    }

    void api
      .runScenarios(
        { suiteId: suite.id, targets, model, embedModel, paceMs, includeSpending },
        {
          onStart: (s) => setTotal(s.total),
          onResult: (r) => setLive((prev) => [...prev, r]),
          onDone: (rep) => setReport(rep),
          onError: (m) => setError(m),
          signal: controller.signal,
        },
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setRunning(false);
        abortRef.current = null;
        props.onRecorded();
      });
  }

  const rows = report?.results ?? live;
  const counts = report?.tally;

  return (
    <div className="space-y-5">
      <Card
        title="Suite"
        subtitle={suite?.description ?? ''}
        right={
          report !== null ? (
            <button
              type="button"
              onClick={() => {
                api
                  .exportReport()
                  .then((r) => setExported(r.mdPath))
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
              }}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-600"
            >
              Export to out/
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {SUITES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSuiteId(s.id)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                s.id === suiteId
                  ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              {s.title}
              <span className="ml-1.5 text-zinc-600">{s.scenarios.length}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label="Model">
            <select className={selectClass} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.length === 0 && <option value="">— no models for this key —</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Embedding model">
            <select
              className={selectClass}
              value={embedModel}
              onChange={(e) => setEmbedModel(e.target.value)}
            >
              {models.length === 0 && <option value="">— no models for this key —</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Compare against" hint="run the same suite on a second gateway">
            <select
              className={selectClass}
              value={secondProfile}
              onChange={(e) => setSecondProfile(e.target.value)}
            >
              <option value="">— one target only —</option>
              {props.config.profiles
                .filter((p) => p.id !== props.profileId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </select>
          </Labelled>
          <Labelled label="Pace between calls" hint="raise it if the key has an RPM cap">
            <select
              className={selectClass}
              value={paceMs}
              onChange={(e) => setPaceMs(Number(e.target.value))}
            >
              {[0, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n} ms
                </option>
              ))}
            </select>
          </Labelled>
        </div>

        <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={includeSpending}
            onChange={(e) => setIncludeSpending(e.target.checked)}
            className="accent-sky-600"
          />
          include scenarios that reach a provider
          <span className="text-zinc-600">
            ({suite?.scenarios.filter((s) => s.spends).length ?? 0} of{' '}
            {suite?.scenarios.length ?? 0} spend)
          </span>
        </label>

        {/*
          Said before the run, not after. A suite that is *expected* to report
          rows as not-yet-built should say so up front — otherwise the first
          reading of the result looks like the gateway is broken.
        */}
        {pendingCount > 0 && (
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            {pendingCount} of {suite?.scenarios.length ?? 0} scenarios here test a feature that is
            still being built. Those expectations state the <em>target</em> behaviour, so a{' '}
            <span className="text-zinc-400">not yet</span> row is the expected result and not a
            defect — and if one comes back{' '}
            <span className="text-emerald-300">pass</span>, the feature has landed.
          </p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {running ? `Running… ${live.length}/${total}` : 'Run suite'}
          </button>
          {running && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-md border border-rose-800 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950/30"
            >
              Stop
            </button>
          )}
          <span className="text-xs text-zinc-600">sequential, so a paced key is not overrun</span>
        </div>

        {error !== null && (
          <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        {exported !== null && (
          <p className="mono mt-3 rounded-md border border-emerald-900/60 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">
            written → {exported}
          </p>
        )}
      </Card>

      {counts !== undefined && (
        <Card title="Result" subtitle={`${report?.suiteTitle} · ${Math.round(report?.durationMs ?? 0)} ms`}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status="pass" label={`${counts.pass} pass`} />
            {counts.fail > 0 && <StatusPill status="fail" label={`${counts.fail} fail`} />}
            {counts['landmine-present'] > 0 && (
              <StatusPill status="warn" label={`${counts['landmine-present']} landmine still present`} />
            )}
            {counts['landmine-changed'] > 0 && (
              <StatusPill status="warn" label={`${counts['landmine-changed']} CHANGED`} />
            )}
            {counts['not-implemented'] > 0 && (
              <StatusPill status="skip" label={`${counts['not-implemented']} not yet built`} />
            )}
            {counts.inconclusive > 0 && (
              <StatusPill status="skip" label={`${counts.inconclusive} blocked`} />
            )}
            {counts.error > 0 && <StatusPill status="fail" label={`${counts.error} error`} />}
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            A <span className="text-amber-300">landmine</span> row matching is the expected state for
            a known defect — it means the bug is still there. A{' '}
            <span className="text-amber-300">CHANGED</span> row means the behaviour moved and someone
            should look: most likely it was fixed. A{' '}
            <span className="text-zinc-400">not yet</span> row is a feature still being built: the
            expectation states the target behaviour, so this is the expected state — and when it
            turns <span className="text-emerald-300">pass</span>, the feature landed. A{' '}
            <span className="text-zinc-400">blocked</span> row means the target refused the request
            outright — nothing was measured, so draw no conclusion from it.
          </p>
        </Card>
      )}

      {rows.length > 0 && <ResultTable rows={rows} />}
      {rows.length === 0 && !running && (
        <Card title="Results" subtitle="Nothing run yet">
          <Empty>Pick a suite and press Run.</Empty>
        </Card>
      )}
    </div>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  );
}

function ResultTable({ rows }: { rows: ScenarioResult[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Exchange | null>(null);
  const multiTarget = new Set(rows.map((r) => r.targetLabel)).size > 1;

  function toggle(row: ScenarioResult): void {
    const key = `${row.targetLabel}:${row.scenarioId}`;
    if (openId === key) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(key);
    setDetail(null);
    api
      .exchange(row.exchangeId)
      .then(setDetail)
      .catch(() => setDetail(null));
  }

  return (
    <Card title="Results" subtitle={multiTarget ? 'Two targets — compare the rows' : undefined}>
      <div className="overflow-hidden rounded-md border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-900/80 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              {multiTarget && <th className="px-3 py-2 font-medium">Target</th>}
              <th className="px-3 py-2 font-medium">Scenario</th>
              <th className="px-3 py-2 font-medium">Outcome</th>
              <th className="px-3 py-2 font-medium">HTTP</th>
              <th className="px-3 py-2 font-medium">Verdict</th>
              <th className="px-3 py-2 font-medium">Notes</th>
              <th className="px-3 py-2 text-right font-medium">ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = `${row.targetLabel}:${row.scenarioId}`;
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => toggle(row)}
                    className="cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-900/60"
                  >
                    {multiTarget && (
                      <td className="px-3 py-2 text-zinc-400">{row.targetLabel}</td>
                    )}
                    <td className="px-3 py-2 text-zinc-200">
                      {row.title}
                      {row.landmine !== undefined && (
                        <span className="mono ml-1.5 rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                          {row.landmine}
                        </span>
                      )}
                      <span
                        className="mono ml-1.5 rounded bg-zinc-800 px-1 text-[10px] text-zinc-500"
                        title={
                          row.reference === 'litellm'
                            ? 'Compatibility target, from documented LiteLLM behaviour — not verified against a local LiteLLM here'
                            : row.reference === 'measured'
                              ? 'Only what this gateway was observed doing. Cannot tell you the behaviour is correct'
                              : row.reference === 'cloudgov'
                                ? 'CloudGov-specific, no external equivalent. Asserts only that the client-visible format is unaffected'
                                : 'A published contract'
                        }
                      >
                        {row.reference}
                      </span>
                      {row.notImplemented !== undefined && (
                        <span
                          className="ml-1.5 block text-[10px] leading-tight text-zinc-600"
                          title={row.notImplemented}
                        >
                          {row.notImplemented.slice(0, 110)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusPill
                        status={OUTCOME_TONE[row.outcome]}
                        label={OUTCOME_LABEL[row.outcome]}
                      />
                    </td>
                    <td className="mono px-3 py-2 text-zinc-300">{row.status ?? '—'}</td>
                    <td className="mono px-3 py-2 text-zinc-400">{row.verdict}</td>
                    <td className="px-3 py-2 text-zinc-500">{row.failures.join('; ')}</td>
                    <td className="mono px-3 py-2 text-right text-zinc-500">{row.totalMs}</td>
                  </tr>
                  {openId === key && (
                    <tr>
                      <td colSpan={multiTarget ? 7 : 6} className="p-0">
                        {detail === null ? (
                          <div className="p-4 text-xs text-zinc-500">Loading…</div>
                        ) : (
                          <ExchangeDetail exchange={detail} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
