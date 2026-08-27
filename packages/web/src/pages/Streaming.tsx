import { useCallback, useMemo, useRef, useState } from 'react';

import {
  analyseStream,
  gapMs,
  readStreamDelta,
  STREAMING_SURFACES,
  withStreaming,
} from '@tokenshield/client';
import type { AuthScheme, Exchange, StreamChunk, SurfaceSpec } from '@tokenshield/client';

import { api } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { RequestComposer } from '../components/RequestComposer';
import { Card, Empty, StatusPill, VerdictPill } from '../components/ui';
import { useComposer } from '../hooks/useComposer';

interface StreamingProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
}

export function Streaming(props: StreamingProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };
  const [includeUsage, setIncludeUsage] = useState(true);

  const transform = useCallback(
    (surface: SurfaceSpec, body: unknown) => withStreaming(surface, body, includeUsage),
    [includeUsage],
  );

  const composer = useComposer(target, {
    surfaces: STREAMING_SURFACES,
    initialSurfaceId: 'chat.completions',
    initialPrompt: 'Count from 1 to 20, one number per line.',
    transform,
    onRecorded: props.onRecorded,
  });

  const [live, setLive] = useState<StreamChunk[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    if (!composer.parsed.ok) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLive([]);
    setExchange(null);
    setError(null);
    setStreaming(true);

    void api
      .streamSurface(
        {
          ...target,
          surfaceId: composer.surface.id,
          body: composer.parsed.value,
        },
        {
          onChunk: (chunk) => setLive((prev) => [...prev, chunk]),
          onDone: (ex) => setExchange(ex),
          onError: (message) => setError(message),
          signal: controller.signal,
        },
      )
      .catch((err: unknown) => {
        // An abort is a deliberate outcome, not a failure to report as one.
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setStreaming(false);
        abortRef.current = null;
        props.onRecorded();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer.parsed, composer.surface, props.profileId, props.keyAlias, props.scheme]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  // Analyse whatever we have: the finished record if it arrived, the live
  // frames otherwise, so the timeline is populated mid-stream too.
  const chunks = exchange?.response?.chunks ?? live;
  const analysis = useMemo(
    () => analyseStream(composer.surface.id, chunks),
    [composer.surface.id, chunks],
  );

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <RequestComposer
        composer={composer}
        surfaces={STREAMING_SURFACES}
        extraControls={
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={includeUsage}
              onChange={(e) => setIncludeUsage(e.target.checked)}
              className="accent-sky-600"
            />
            <span>
              <span className="mono">stream_options.include_usage</span> — ask for token counts in
              the final frame (chat completions only)
            </span>
          </label>
        }
        actions={
          <>
            <button
              type="button"
              onClick={start}
              disabled={streaming || !composer.parsed.ok}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {streaming ? 'Streaming…' : 'Stream'}
            </button>
            {streaming && (
              <button
                type="button"
                onClick={stop}
                className="rounded-md border border-rose-800 px-3 py-2 text-sm text-rose-300 hover:bg-rose-950/30"
              >
                Stop
              </button>
            )}
          </>
        }
        sendHint={
          <span className="text-xs text-amber-500/80">
            reaches a provider · real tokens, real spend
          </span>
        }
      />

      <div className="space-y-5">
        <Card
          title="Live output"
          subtitle={
            streaming
              ? `${live.length} frame(s) so far`
              : exchange !== null
                ? `${analysis.chunkCount} frames · ${analysis.textChunks} carried text`
                : 'Nothing streamed yet'
          }
          right={
            exchange !== null ? (
              <VerdictPill kind={exchange.verdict.kind} />
            ) : streaming ? (
              <StatusPill status="warn" label="streaming" />
            ) : undefined
          }
        >
          {chunks.length === 0 && error === null ? (
            <Empty>Press Stream to watch frames arrive.</Empty>
          ) : (
            <>
              <pre className="mono max-h-60 min-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-100">
                {analysis.text.length > 0 ? analysis.text : '—'}
                {streaming && <span className="animate-pulse text-sky-400">▋</span>}
              </pre>
              {error !== null && (
                <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
                  {error}
                </p>
              )}
              {exchange?.transportError !== undefined && (
                <p className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-300">
                  {exchange.transportError}
                </p>
              )}
            </>
          )}
        </Card>

        {chunks.length > 0 && (
          <Card title="Timing" subtitle="When frames arrived, and where the stalls were">
            <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <Metric label="First frame" value={ms(analysis.firstChunkMs)} />
              <Metric label="First text" value={ms(analysis.firstTextMs)} />
              <Metric label="Last frame" value={ms(analysis.lastChunkMs)} />
              <Metric label="Max gap" value={`${analysis.maxGapMs} ms`} />
              <Metric label="Mean gap" value={`${analysis.meanGapMs} ms`} />
              <Metric label="Frames" value={String(analysis.chunkCount)} />
              <Metric label="Finish" value={analysis.finishReason ?? '—'} />
              <Metric
                label="Tokens in/out"
                value={
                  analysis.usage !== undefined
                    ? `${analysis.usage.input ?? '?'} / ${analysis.usage.output ?? '?'}`
                    : '—'
                }
              />
            </div>
            <p className="mt-3 text-[11px] text-zinc-600">
              {analysis.sawDone
                ? 'Terminated with [DONE].'
                : 'No [DONE] sentinel seen — expected for the Anthropic and Responses surfaces.'}
            </p>
          </Card>
        )}

        {analysis.anomalies.length > 0 && (
          <Card
            title="Conformance"
            subtitle="Things a strict client would trip over, even when the text is fine"
          >
            <ul className="space-y-1.5 text-xs">
              {analysis.anomalies.slice(0, 24).map((a, i) => (
                <li
                  key={`${a.seq}-${i}`}
                  className="flex gap-2 rounded-md border border-amber-900/50 bg-amber-950/15 px-2.5 py-1.5"
                >
                  <span className="mono shrink-0 text-amber-500/70">
                    {a.seq === -1 ? 'stream' : `#${a.seq}`}
                  </span>
                  <span className="text-amber-200/90">{a.issue}</span>
                </li>
              ))}
            </ul>
            {analysis.anomalies.length > 24 && (
              <p className="mt-2 text-xs text-zinc-600">
                and {analysis.anomalies.length - 24} more of the same kinds
              </p>
            )}
          </Card>
        )}

        {chunks.length > 0 && <ChunkTimeline surfaceId={composer.surface.id} chunks={chunks} />}

        {exchange !== null && (
          <Card title="Exchange" subtitle="Headers, request and the recorded stream">
            <div className="-m-4">
              <ExchangeDetail exchange={exchange} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function ms(value: number | undefined): string {
  return value === undefined ? '—' : `${value} ms`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className="mono mt-0.5 truncate text-zinc-200" title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * Frame-by-frame, with an inline bar per inter-frame gap. A stall shows up as a
 * long bar, which is far easier to spot than scanning a column of numbers.
 */
function ChunkTimeline({
  surfaceId,
  chunks,
}: {
  surfaceId: string;
  chunks: readonly StreamChunk[];
}) {
  const maxGap = useMemo(() => {
    let max = 1;
    for (let i = 1; i < chunks.length; i++) {
      const gap = gapMs(chunks[i]?.t ?? 0, chunks[i - 1]?.t ?? 0);
      if (gap > max) max = gap;
    }
    return max;
  }, [chunks]);

  return (
    <Card title="Frame timeline" subtitle={`${chunks.length} frames, newest last`}>
      <div className="max-h-96 overflow-auto rounded-md border border-zinc-800">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-zinc-900/95 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">t</th>
              <th className="px-2 py-1.5 font-medium">gap</th>
              <th className="px-2 py-1.5 font-medium">event</th>
              <th className="px-2 py-1.5 font-medium">delta</th>
            </tr>
          </thead>
          <tbody>
            {chunks.map((chunk, i) => {
              const gap = i === 0 ? 0 : gapMs(chunk.t, chunks[i - 1]?.t ?? 0);
              const delta = readStreamDelta(surfaceId, chunk);
              const label = chunk.done === true ? '[DONE]' : (chunk.event ?? '—');
              return (
                <tr key={chunk.seq} className="border-t border-zinc-800/60">
                  <td className="mono px-2 py-1 text-zinc-600">{chunk.seq}</td>
                  <td className="mono px-2 py-1 text-zinc-400">{chunk.t}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <div
                        className="h-1.5 rounded-full bg-sky-700"
                        style={{ width: `${Math.max(2, (gap / maxGap) * 60)}px` }}
                      />
                      <span className="mono text-zinc-600">{gap}</span>
                    </div>
                  </td>
                  <td className="mono px-2 py-1 text-zinc-500">
                    {chunk.comment === true ? ': comment' : label}
                    {chunk.incomplete === true && (
                      <span className="ml-1 text-rose-400">cut</span>
                    )}
                    {chunk.parsed === undefined && chunk.done !== true && chunk.comment !== true && (
                      <span className="ml-1 text-amber-400">unparsed</span>
                    )}
                  </td>
                  <td className="mono px-2 py-1 text-zinc-300">
                    {delta !== undefined ? (
                      JSON.stringify(delta)
                    ) : (
                      <span className="text-zinc-700">{chunk.raw.slice(0, 60) || '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
