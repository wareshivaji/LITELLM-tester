import { Fragment, useEffect, useMemo, useState } from 'react';

import { readOutput, sdkModesFor, SURFACES } from '@tokenshield/client';
import type { AuthScheme, Exchange, SdkMode, SdkOutcome } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { RequestComposer } from '../components/RequestComposer';
import { Card, Empty, Json, StatusPill, VerdictPill } from '../components/ui';
import { useComposer } from '../hooks/useComposer';
import type { ModelCatalogue } from '../hooks/useModelCatalogue';


const MODE_LABEL: Record<SdkMode, string> = {
  raw: 'raw HTTP',
  'openai-sdk': 'openai',
  'anthropic-sdk': '@anthropic-ai/sdk',
};

const MODE_BLURB: Record<SdkMode, string> = {
  raw: 'Hand-built request. Sends exactly what the body says.',
  'openai-sdk': 'The stock openai package, unmodified.',
  'anthropic-sdk': 'The stock @anthropic-ai/sdk package, unmodified.',
};

interface SdkCompareProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
  catalogue: ModelCatalogue;
}

export function SdkCompare(props: SdkCompareProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };
  const composer = useComposer({
    surfaces: SURFACES,
    initialSurfaceId: 'chat.completions',
    models: props.catalogue.models,
    modelsError: props.catalogue.error,
  });

  const available = useMemo(() => sdkModesFor(composer.surface.id), [composer.surface.id]);
  const [selected, setSelected] = useState<SdkMode[]>(['raw', 'openai-sdk']);
  const [maxRetries, setMaxRetries] = useState(0);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<SdkOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keep the selection legal when the surface changes. The Anthropic SDK now
  // has NO legal surface at all — /v1/messages left the tested scope — so this
  // guard resolves it away rather than offering a mode that cannot run.
  // Previously the reason was that the SDK had no method for /v1/embeddings, and
  // offering it would produce a confusing
  // client-side error rather than a gateway finding.
  useEffect(() => {
    setSelected((current) => {
      const legal = current.filter((m) => available.includes(m));
      return legal.length > 0 ? legal : available.slice(0, 2);
    });
  }, [available]);

  function toggle(mode: SdkMode): void {
    setSelected((current) =>
      current.includes(mode) ? current.filter((m) => m !== mode) : [...current, mode],
    );
  }

  function run(): void {
    if (!composer.parsed.ok || selected.length === 0) return;
    setRunning(true);
    setError(null);
    setOutcomes(null);
    api
      .compare({
        ...target,
        surfaceId: composer.surface.id,
        body: composer.parsed.value,
        modes: selected,
        maxRetries,
      })
      .then((res) => setOutcomes(res.outcomes))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setRunning(false);
        props.onRecorded();
      });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <RequestComposer
          composer={composer}
          surfaces={SURFACES}
          showProbes
          extraControls={
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Clients
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(['raw', 'openai-sdk', 'anthropic-sdk'] as const).map((mode) => {
                    const usable = available.includes(mode);
                    const on = selected.includes(mode);
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={!usable}
                        onClick={() => toggle(mode)}
                        title={
                          usable
                            ? MODE_BLURB[mode]
                            : `No method on this SDK for ${composer.surface.label}`
                        }
                        className={`mono rounded-md border px-2.5 py-1 text-xs ${
                          !usable
                            ? 'cursor-not-allowed border-zinc-900 text-zinc-700'
                            : on
                              ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                              : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
                        }`}
                      >
                        {MODE_LABEL[mode]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="uppercase tracking-wider text-zinc-500">SDK maxRetries</span>
                <select
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                  className="mono rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                >
                  {[0, 1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className="text-zinc-600">
                  raise it to watch an SDK retry a 429 or 5xx on its own schedule
                </span>
              </label>
            </div>
          }
          actions={
            <button
              type="button"
              onClick={run}
              disabled={running || !composer.parsed.ok || selected.length === 0}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? 'Running…' : `Send via ${selected.length} client(s)`}
            </button>
          }
          onSubmit={run}
          sendHint={
            <span className="text-xs text-amber-500/80">
              one call per client, run in sequence · real tokens
            </span>
          }
        />

        <Card
          title="Verdict comparison"
          subtitle="Same body, different clients. Divergence is the finding."
        >
          {error !== null && (
            <p className="rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}
          {outcomes === null ? (
            <Empty>
              Send the same request through raw HTTP and a vendor SDK to see where they disagree.
            </Empty>
          ) : (
            <Divergence outcomes={outcomes} />
          )}
        </Card>
      </div>

      {outcomes !== null && (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {outcomes.map((outcome) => (
            <OutcomeCard key={outcome.mode} outcome={outcome} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The one-glance answer: did the clients agree? */
function Divergence({ outcomes }: { outcomes: SdkOutcome[] }) {
  const rows = outcomes.map((o) => {
    const last = o.attempts[o.attempts.length - 1];
    return {
      mode: o.mode,
      ok: o.ok,
      status: last?.response?.status ?? null,
      verdict: last?.verdict.kind ?? 'unknown',
      envelope: last?.verdict.envelope ?? 'none',
      attempts: o.attempts.length,
      reported: o.ok
        ? (readOutput(last?.surface ?? '', last?.response?.body).text ?? '(no text)')
        : `${o.failure?.name ?? 'Error'}: ${o.failure?.message ?? ''}`,
      totalMs: o.attempts.reduce((sum, a) => sum + a.timings.totalMs, 0),
    };
  });

  const statuses = new Set(rows.map((r) => String(r.status)));
  const oks = new Set(rows.map((r) => r.ok));
  const agree = statuses.size === 1 && oks.size === 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <StatusPill
          status={agree ? 'pass' : 'warn'}
          label={agree ? 'clients agree' : 'clients disagree'}
        />
        {!agree && (
          <span className="text-xs text-amber-400/80">
            the same request got different answers depending on who sent it
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-900/80 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Client</th>
              <th className="px-3 py-2 font-medium">HTTP</th>
              <th className="px-3 py-2 font-medium">Verdict</th>
              <th className="px-3 py-2 font-medium">Envelope</th>
              <th className="px-3 py-2 font-medium">Attempts</th>
              <th className="px-3 py-2 text-right font-medium">ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.mode}>
                <tr className="border-t border-zinc-800/60">
                  <td className="mono px-3 py-2 text-zinc-200">{MODE_LABEL[r.mode]}</td>
                  <td className="mono px-3 py-2 text-zinc-300">{r.status ?? '—'}</td>
                  <td className="px-3 py-2">
                    <VerdictPill kind={r.verdict} />
                  </td>
                  <td className="mono px-3 py-2 text-zinc-400">{r.envelope}</td>
                  <td
                    className={`mono px-3 py-2 ${r.attempts > 1 ? 'text-amber-300' : 'text-zinc-400'}`}
                  >
                    {r.attempts}
                  </td>
                  <td className="mono px-3 py-2 text-right text-zinc-400">
                    {Math.round(r.totalMs)}
                  </td>
                </tr>
                <tr className="border-t border-zinc-900">
                  <td colSpan={6} className="px-3 pb-2 text-[11px] text-zinc-500">
                    <span className="text-zinc-600">what the client reported: </span>
                    <span className={r.ok ? 'text-zinc-300' : 'text-rose-300'}>
                      {r.reported.slice(0, 220)}
                    </span>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OutcomeCard({ outcome }: { outcome: SdkOutcome }) {
  const [openAttempt, setOpenAttempt] = useState<Exchange | null>(null);

  return (
    <Card
      title={MODE_LABEL[outcome.mode]}
      subtitle={MODE_BLURB[outcome.mode]}
      right={<StatusPill status={outcome.ok ? 'pass' : 'fail'} label={outcome.ok ? 'ok' : 'threw'} />}
    >
      <div className="space-y-3">
        {outcome.failure !== undefined && (
          <div className="rounded-md border border-rose-900/60 bg-rose-950/20 p-3">
            <div className="text-[10px] uppercase tracking-wider text-rose-400/70">
              What a developer&rsquo;s catch block receives
            </div>
            <div className="mono mt-1 text-sm text-rose-200">{outcome.failure.name}</div>
            <div className="mt-1 text-xs text-rose-300/90">{outcome.failure.message}</div>
            <div className="mono mt-2 flex flex-wrap gap-2 text-[10px] text-rose-400/70">
              <span>status: {outcome.failure.status ?? '—'}</span>
              <span>type: {outcome.failure.type ?? '—'}</span>
              <span>code: {outcome.failure.code ?? '—'}</span>
              <span className={outcome.failure.typed ? '' : 'text-amber-400'}>
                {outcome.failure.typed
                  ? 'typed API error'
                  : 'untyped — the SDK could not classify it'}
              </span>
            </div>
          </div>
        )}

        {outcome.sdkHeaders.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              Headers this SDK added
            </div>
            <div className="mono flex flex-wrap gap-1 text-[10px]">
              {outcome.sdkHeaders.map((h) => (
                <span key={h} className="rounded bg-zinc-900 px-1.5 py-0.5 text-zinc-400">
                  {h}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
            HTTP attempts ({outcome.attempts.length})
          </div>
          <div className="space-y-1">
            {outcome.attempts.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setOpenAttempt(openAttempt?.id === a.id ? null : a)}
                className="mono flex w-full items-center gap-2 rounded-md border border-zinc-800 px-2 py-1 text-left text-[11px] text-zinc-400 hover:border-zinc-700"
              >
                <span className="text-zinc-600">#{i + 1}</span>
                <span className="text-zinc-300">{a.response?.status ?? '—'}</span>
                <span>{a.verdict.kind}</span>
                <span className="ml-auto text-zinc-600">{a.timings.totalMs} ms</span>
              </button>
            ))}
          </div>
        </div>

        {openAttempt !== null && (
          <div className="-mx-4 -mb-4">
            <ExchangeDetail exchange={openAttempt} />
          </div>
        )}

        {outcome.ok && outcome.result !== undefined && (
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              What the client parsed
            </div>
            <Json value={outcome.result} maxHeight={180} />
          </div>
        )}
      </div>
    </Card>
  );
}
