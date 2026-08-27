import { useState } from 'react';

import { readOutput, readUsage, SURFACES } from '@tokenshield/client';
import type { AuthScheme, Exchange } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { RequestComposer } from '../components/RequestComposer';
import { Card, Empty, Json, VerdictPill } from '../components/ui';
import { useComposer } from '../hooks/useComposer';

interface PlaygroundProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
}

export function Playground(props: PlaygroundProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };
  const composer = useComposer(target, {
    surfaces: SURFACES,
    initialSurfaceId: 'chat.completions',
    onRecorded: props.onRecorded,
  });

  const [sending, setSending] = useState(false);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  function send(): void {
    if (!composer.parsed.ok) return;
    setSending(true);
    setSendError(null);
    api
      .callSurface({ ...target, surfaceId: composer.surface.id, body: composer.parsed.value })
      .then((ex) => setExchange(ex))
      .catch((err: unknown) => setSendError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setSending(false);
        props.onRecorded();
      });
  }

  const output = exchange !== null ? readOutput(exchange.surface, exchange.response?.body) : null;
  const usage = exchange !== null ? readUsage(exchange.response?.body) : undefined;

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <RequestComposer
        composer={composer}
        surfaces={SURFACES}
        showProbes
        actions={
          <button
            type="button"
            onClick={send}
            disabled={sending || !composer.parsed.ok}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Sending…' : `Send to ${composer.surface.label}`}
          </button>
        }
        sendHint={
          <span className="text-xs text-amber-500/80">
            reaches a provider · real tokens, real spend
          </span>
        }
      />

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
          {sendError !== null && (
            <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
              {sendError}
            </p>
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
