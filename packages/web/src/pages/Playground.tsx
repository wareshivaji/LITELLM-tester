import { useCallback, useEffect, useMemo, useState } from 'react';

import { probesFor, readOutput, readUsage, SURFACES } from '@tokenshield/client';
import type { AuthScheme, Exchange, ModelInfo, Probe, SurfaceSpec } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { Card, Empty, Json, selectClass, VerdictPill } from '../components/ui';

const DEFAULT_PROMPT = 'Reply with exactly: pong';

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface PlaygroundProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
}

export function Playground(props: PlaygroundProps) {
  const [surfaceId, setSurfaceId] = useState<string>('chat.completions');
  const surface = useMemo(
    () => SURFACES.find((s) => s.id === surfaceId) ?? SURFACES[0]!,
    [surfaceId],
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  const [bodyText, setBodyText] = useState('');
  /** Once hand-edited, model/prompt changes stop clobbering the editor. */
  const [dirty, setDirty] = useState(false);

  const [sending, setSending] = useState(false);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastProbe, setLastProbe] = useState<Probe | null>(null);

  // Model catalogue for the current target. Free — one GET /v1/models.
  useEffect(() => {
    if (props.keyAlias === null) {
      setModels([]);
      setModelsError('Select a key on the Connect page to load its model catalogue.');
      return;
    }
    setModelsError(null);
    api
      .models({ profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme })
      .then((res) => {
        setModels(res.models);
        if (res.models.length === 0) {
          setModelsError(`No models available — ${res.verdict.kind}: ${res.verdict.detail}`);
        }
        setModel((current) =>
          res.models.some((m) => m.id === current) ? current : (res.models[0]?.id ?? ''),
        );
        props.onRecorded();
      })
      .catch((err: unknown) => {
        setModels([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.profileId, props.keyAlias, props.scheme]);

  const regenerate = useCallback(() => {
    setBodyText(pretty(surface.sample(model, prompt)));
    setDirty(false);
    setLastProbe(null);
  }, [surface, model, prompt]);

  // Rebuild the body when the surface, model or prompt changes — unless the
  // body has been hand-edited, in which case the edit wins.
  useEffect(() => {
    if (!dirty) setBodyText(pretty(surface.sample(model, prompt)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, model, prompt]);

  const parsed = useMemo((): { ok: true; value: unknown } | { ok: false; error: string } => {
    try {
      return { ok: true, value: JSON.parse(bodyText) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  }, [bodyText]);

  function applyProbe(probe: Probe): void {
    if (!parsed.ok) return;
    setBodyText(pretty(probe.apply(parsed.value)));
    setDirty(true);
    setLastProbe(probe);
  }

  function send(): void {
    if (!parsed.ok) return;
    setSending(true);
    setSendError(null);
    api
      .callSurface({
        profileId: props.profileId,
        keyAlias: props.keyAlias,
        scheme: props.scheme,
        surfaceId: surface.id,
        body: parsed.value,
      })
      .then((ex) => setExchange(ex))
      .catch((err: unknown) => setSendError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setSending(false);
        props.onRecorded();
      });
  }

  const output = exchange !== null ? readOutput(exchange.surface, exchange.response?.body) : null;
  const usage = exchange !== null ? readUsage(exchange.response?.body) : undefined;
  const probes = probesFor(surface.id);

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {/* ── Compose ── */}
      <div className="space-y-5">
        <Card title="Surface" subtitle={surface.docs}>
          <div className="flex flex-wrap gap-1.5">
            {SURFACES.map((s) => (
              <SurfaceTab
                key={s.id}
                spec={s}
                active={s.id === surface.id}
                onClick={() => {
                  setSurfaceId(s.id);
                  setDirty(false);
                  setLastProbe(null);
                }}
              />
            ))}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
                Model
              </span>
              <select
                className={selectClass}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={models.length === 0}
              >
                {models.length === 0 && <option value="">— none loaded —</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
              {modelsError !== null && (
                <span className="mt-1 block text-xs text-amber-500">{modelsError}</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
                Prompt
              </span>
              <textarea
                className={`${selectClass} min-h-[42px] resize-y`}
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          </div>
        </Card>

        <Card
          title="Probes"
          subtitle="Each one patches the body below to answer a specific question. ⚠ marks behaviour believed to be wrong today."
        >
          <div className="flex flex-wrap gap-1.5">
            {probes.map((probe) => (
              <button
                key={probe.id}
                type="button"
                title={`${probe.why} (expected: ${probe.expectation})`}
                onClick={() => applyProbe(probe)}
                disabled={!parsed.ok}
                className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
                  probe.landmine
                    ? 'border-amber-800/70 text-amber-300 hover:bg-amber-950/30'
                    : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800/60'
                }`}
              >
                {probe.label}
              </button>
            ))}
          </div>
          {lastProbe !== null && (
            <p className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-200">{lastProbe.label}</span> — {lastProbe.why}
              <span className="mt-1 block text-zinc-600">expected: {lastProbe.expectation}</span>
            </p>
          )}
        </Card>

        <Card
          title="Request body"
          subtitle="Sent verbatim. Nothing here is validated or corrected — that is the point."
          right={
            <button
              type="button"
              onClick={regenerate}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
            >
              reset
            </button>
          }
        >
          <textarea
            className="mono h-64 w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-200 outline-none focus:border-sky-700"
            spellCheck={false}
            value={bodyText}
            onChange={(e) => {
              setBodyText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={send}
              disabled={sending || !parsed.ok}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? 'Sending…' : `Send to ${surface.label}`}
            </button>
            {parsed.ok ? (
              <span className="text-xs text-amber-500/80">
                reaches a provider · real tokens, real spend
              </span>
            ) : (
              <span className="mono text-xs text-rose-400">JSON: {parsed.error}</span>
            )}
          </div>
          {sendError !== null && (
            <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
              {sendError}
            </p>
          )}
        </Card>
      </div>

      {/* ── Result ── */}
      <div className="space-y-5">
        <Card
          title="Result"
          subtitle={
            exchange !== null
              ? `${exchange.profileLabel} · ${exchange.surface} · ${exchange.timings.totalMs} ms`
              : 'Nothing sent yet'
          }
          right={exchange !== null ? <VerdictPill kind={exchange.verdict.kind} /> : undefined}
        >
          {exchange === null ? (
            <Empty>Send a request to see the response, the verdict and the full exchange.</Empty>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                  {exchange.verdict.kind === 'ok' ? 'Output' : 'Why it failed'}
                </div>
                {exchange.verdict.kind === 'ok' ? (
                  output?.text !== undefined ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-100">{output.text}</p>
                  ) : (
                    <p className="mono mt-1 text-sm text-zinc-300">
                      {output?.note ?? 'Succeeded, but no readable output for this surface.'}
                    </p>
                  )
                ) : (
                  <p className="mt-1 text-sm text-zinc-200">{exchange.verdict.detail}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <Meta label="Envelope" value={exchange.verdict.envelope} />
                <Meta label="Code" value={exchange.verdict.code ?? '—'} />
                <Meta label="Finish" value={output?.finishReason ?? '—'} />
                <Meta
                  label="Tokens in/out"
                  value={
                    usage !== undefined ? `${usage.input ?? '?'} / ${usage.output ?? '?'}` : '—'
                  }
                />
              </div>

              {output?.note !== undefined && output.text !== undefined && (
                <p className="text-xs text-amber-500/80">{output.note}</p>
              )}
            </div>
          )}
        </Card>

        {exchange !== null && (
          <Card title="Exchange" subtitle="Everything the gateway sent back">
            <div className="-m-4">
              <ExchangeDetail exchange={exchange} />
            </div>
          </Card>
        )}

        {exchange !== null && exchange.gateway.budget !== undefined && (
          <Card title="Budget headers" subtitle="What the gateway reported about spend">
            <Json value={exchange.gateway.budget} maxHeight={200} />
          </Card>
        )}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="mono mt-0.5 truncate text-zinc-200" title={value}>
        {value}
      </div>
    </div>
  );
}

const FAMILY_TONE: Record<string, string> = {
  openai: 'border-sky-800/60 text-sky-200 bg-sky-950/30',
  anthropic: 'border-violet-800/60 text-violet-200 bg-violet-950/30',
  utility: 'border-zinc-700 text-zinc-300 bg-zinc-900/60',
};

function SurfaceTab({
  spec,
  active,
  onClick,
}: {
  spec: SurfaceSpec;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2.5 py-1 text-xs ${
        active
          ? FAMILY_TONE[spec.family]
          : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
      }`}
    >
      {spec.label}
    </button>
  );
}
