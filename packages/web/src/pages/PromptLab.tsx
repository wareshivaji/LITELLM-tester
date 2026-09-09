import { useEffect, useMemo, useRef, useState } from 'react';

import type { AuthScheme, PromptResult, PromptSurfaceId } from '@tokenshield/client';

import { api, runPrompts } from '../api';
import type { PromptCatalogue, PromptDryRun } from '../api';
import {
  Button,
  Card,
  Checkbox,
  Empty,
  Json,
  Label,
  Notice,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
} from '../components/ui';
import type { ModelCatalogue } from '../hooks/useModelCatalogue';

interface PromptLabProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
  catalogue: ModelCatalogue;
}

const SURFACE_LABEL: Record<PromptSurfaceId, string> = {
  'chat.completions': '/v1/chat/completions',
  responses: '/v1/responses',
};

export function PromptLab(props: PromptLabProps) {
  const [catalogue, setCatalogue] = useState<PromptCatalogue | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [surfaces, setSurfaces] = useState<PromptSurfaceId[]>(['chat.completions', 'responses']);
  const [model, setModel] = useState('');
  const [results, setResults] = useState<PromptResult[]>([]);
  const [dryRun, setDryRun] = useState<PromptDryRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .promptCases()
      .then((c) => {
        if (!live) return;
        setCatalogue(c);
        setSelected(c.cases.map((x) => x.id));
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const models = props.catalogue.models;
  useEffect(() => {
    if (model === '' && models.length > 0) setModel(models[0]?.id ?? '');
  }, [models, model]);

  const chosen = useMemo(
    () => (catalogue?.cases ?? []).filter((c) => selected.includes(c.id)),
    [catalogue, selected],
  );

  // Shown before anything is sent. Every case here reaches a provider, so the
  // ceiling belongs on screen next to the button, not in a doc somewhere.
  const estimate = useMemo(
    () => ({
      calls: chosen.length * surfaces.length,
      tokens: chosen.reduce((sum, c) => sum + c.maxTokens * surfaces.length, 0),
    }),
    [chosen, surfaces],
  );

  const body = (): Record<string, unknown> => ({
    profileId: props.profileId,
    keyAlias: props.keyAlias,
    scheme: props.scheme,
    caseIds: selected,
    surfaces,
    model,
  });

  const toggleCase = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSurface = (id: PromptSurfaceId): void => {
    setSurfaces((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const preview = async (): Promise<void> => {
    setError(null);
    setResults([]);
    try {
      setDryRun(await api.promptDryRun(body()));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (): Promise<void> => {
    setError(null);
    setResults([]);
    setDryRun(null);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let done = 0;
    await runPrompts(body(), {
      signal: controller.signal,
      onStart: (info) => setProgress({ done: 0, total: info.total }),
      onResult: (r) => {
        done += r.outcomes.length;
        setProgress((p) => (p === null ? p : { ...p, done }));
        setResults((prev) => [...prev, r]);
        props.onRecorded();
      },
      onDone: () => setRunning(false),
      onError: (m) => {
        setError(m);
        setRunning(false);
      },
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    });
    setRunning(false);
  };

  const stop = (): void => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const passed = results.filter((r) => r.ok).length;
  const disagreed = results.filter((r) => !r.comparison.agrees).length;

  return (
    <div className="space-y-4">
      <Card
        title="Prompt testing"
        subtitle="One prompt, both surfaces, checked on what came back rather than on the HTTP envelope."
      >
        <p className="text-[12px] leading-relaxed text-zinc-500">
          A scenario asks whether the gateway answered in the right <em>shape</em>. This asks
          whether it did the right <em>thing</em> — and whether it does the same thing on both
          surfaces. The two disagree about everything: a user turn is <code>messages[]</code> on one
          and <code>input[]</code> with explicit content parts on the other, the answer is{' '}
          <code>choices[0].message.content</code> versus an <code>output[]</code> array, and tool
          calls live in different places entirely. A customer migrating between them has no way to
          check they got the same behaviour. That is what the <strong>agree</strong> column is.
        </p>

        {catalogue !== null && (
          <p className="mt-2 text-[11px] text-zinc-600">
            MCP cases point at the lab&rsquo;s own server, <code>{catalogue.mcpServerUrl}</code> —
            no configured org needed. Its answer is deliberately absurd, so if the phrase comes back
            the tool genuinely ran.
          </p>
        )}
      </Card>

      <Card title="What to send">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Label>Model</Label>
            <Select
              value={model === '' ? undefined : model}
              onValueChange={setModel}
              disabled={models.length === 0}
            >
              <SelectTrigger size="sm" className="w-64">
                <SelectValue placeholder="(no catalogue)" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500">Surfaces</span>
            {(['chat.completions', 'responses'] as PromptSurfaceId[]).map((s) => (
              <label
                key={s}
                htmlFor={`surface-${s}`}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Checkbox
                  id={`surface-${s}`}
                  checked={surfaces.includes(s)}
                  onCheckedChange={() => toggleSurface(s)}
                />
                <code>{SURFACE_LABEL[s]}</code>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          {(catalogue?.cases ?? []).map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-start gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 hover:border-zinc-700"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected.includes(c.id)}
                onCheckedChange={() => toggleCase(c.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{c.title}</span>
                  {c.useMcp && (
                    <span className="mono rounded bg-violet-500/10 px-1 text-[10px] text-violet-300">
                      mcp
                    </span>
                  )}
                  {c.tools !== 'none' && (
                    <span className="mono rounded bg-sky-500/10 px-1 text-[10px] text-sky-300">
                      {c.tools}
                    </span>
                  )}
                  <span className="mono text-[10px] text-zinc-600">max {c.maxTokens}</span>
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">
                  {c.why}
                </span>
                <span className="mono mt-1 block truncate text-[10px] text-zinc-600">
                  &ldquo;{c.prompt}&rdquo;
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
            onClick={() => void preview()}
            disabled={running || estimate.calls === 0}
          >
            Preview requests
          </button>
          <Button
            type="button"
            size="sm"
            onClick={() => void run()}
            disabled={running || estimate.calls === 0 || props.keyAlias === null}
          >
            {running ? 'Running…' : 'Run prompts'}
          </Button>
          {running && (
            <button
              type="button"
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
              onClick={stop}
            >
              Stop
            </button>
          )}
          <span className="text-[11px] text-amber-400">
            real tokens, real spend — {estimate.calls} calls, ≤{estimate.tokens} output tokens
          </span>
          {progress !== null && (
            <span className="text-[11px] text-zinc-500">
              {progress.done}/{progress.total}
            </span>
          )}
        </div>

        {props.keyAlias === null && (
          <Notice tone="warn" title="No credential selected">
            Prompt testing needs a key — every case reaches a provider. Pick one in the target strip
            above.
          </Notice>
        )}
        {error !== null && (
          <Notice tone="warn" title="Run failed">
            {error}
          </Notice>
        )}
      </Card>

      {dryRun !== null && (
        <Card
          title="Preview — nothing was sent"
          subtitle={`${dryRun.estimate.calls} calls, ceiling ${dryRun.estimate.maxOutputTokens} output tokens`}
        >
          <p className="mb-2 text-[11px] text-zinc-500">
            The exact bytes each surface would receive. Worth reading once: the same prompt becomes
            two quite different requests.
          </p>
          {dryRun.requests.map((r, i) => (
            <div key={`${r.caseId}-${r.surface}-${i}`} className="mb-2">
              <div className="mono mb-1 text-[10px] text-zinc-500">
                {r.caseId} · {r.path}
              </div>
              <Json value={r.body} />
            </div>
          ))}
        </Card>
      )}

      {results.length > 0 && (
        <Card title="Results">
          <div className="mb-3 flex flex-wrap gap-2">
            <StatusPill status="pass" label={`${passed}/${results.length} behaved`} />
            {disagreed > 0 && (
              <StatusPill status="warn" label={`${disagreed} surface disagreement`} />
            )}
          </div>

          <div className="space-y-3">
            {results.map((r) => (
              <div key={r.caseId} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={r.ok ? 'pass' : 'fail'} label={r.ok ? 'behaved' : 'FAIL'} />
                  <span className="text-xs font-medium text-zinc-200">{r.title}</span>
                  {!r.comparison.agrees && (
                    <span className="mono rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">
                      surfaces disagree
                    </span>
                  )}
                </div>

                {r.comparison.differences.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {r.comparison.differences.map((d, i) => (
                      <li key={i} className="text-[11px] text-amber-300">
                        {d}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {r.outcomes.map((o) => (
                    <div key={o.surface} className="rounded border border-zinc-800 bg-zinc-950 p-2">
                      <div className="flex items-center gap-2">
                        <code className="text-[10px] text-zinc-400">
                          {SURFACE_LABEL[o.surface]}
                        </code>
                        <StatusPill status={o.ok ? 'pass' : 'fail'} />
                        <span className="mono text-[10px] text-zinc-600">
                          {o.status ?? '—'} · {Math.round(o.totalMs)}ms
                        </span>
                      </div>

                      {/*
                        Two kinds of tool call, never merged. A sky chip is a
                        call handed BACK for the client to run; a violet one is
                        a tool the GATEWAY already ran. Showing them as one list
                        would erase the distinction the page exists to observe.
                      */}
                      {(o.toolCalls ?? []).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-zinc-600">yours to run:</span>
                          {(o.toolCalls ?? []).map((c, i) => (
                            <span
                              key={i}
                              className="mono rounded bg-sky-500/10 px-1 text-[10px] text-sky-300"
                            >
                              {c.name}
                            </span>
                          ))}
                        </div>
                      )}

                      {(o.brokeredCalls ?? []).length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-zinc-600">gateway ran:</span>
                          {(o.brokeredCalls ?? []).map((c, i) => (
                            <span
                              key={i}
                              className="mono rounded bg-violet-500/10 px-1 text-[10px] text-violet-300"
                              title={`${c.serverLabel} · ${c.argumentsText}`}
                            >
                              {c.name}
                              {c.error !== undefined && ' ✕'}
                              {c.truncated && ' ✂'}
                            </span>
                          ))}
                        </div>
                      )}

                      {(o.offeredTools ?? []).length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[10px] text-zinc-600">
                            {(o.offeredTools ?? []).length} tools offered to the model
                          </summary>
                          <div className="mono mt-1 text-[10px] leading-relaxed text-zinc-500">
                            {(o.offeredTools ?? []).join(', ')}
                          </div>
                          <p className="mt-1 text-[10px] leading-tight text-zinc-600">
                            A blocked tool is absent from this list rather than refused — so this is
                            where a BLOCK policy is proved, not in the answer text.
                          </p>
                        </details>
                      )}

                      {(o.mcpIssues ?? []).length > 0 && (
                        <ul className="mt-1.5 space-y-0.5 border-t border-zinc-800 pt-1.5">
                          {(o.mcpIssues ?? []).map((issue, i) => (
                            <li key={i} className="text-[10px] leading-tight text-amber-300/80">
                              <span className="mono text-amber-400">{issue.kind}</span> —{' '}
                              {issue.detail}
                            </li>
                          ))}
                        </ul>
                      )}

                      {o.text.trim().length > 0 ? (
                        <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300">
                          {o.text.length > 400 ? `${o.text.slice(0, 400)}…` : o.text}
                        </p>
                      ) : (
                        <p className="mt-1.5 text-[11px] italic text-zinc-600">
                          {(o.toolCalls ?? []).length > 0
                            ? 'no text — tool call only'
                            : (o.brokeredCalls ?? []).length > 0
                              ? 'no text — the gateway ran a tool and the model said nothing'
                              : 'no text'}
                        </p>
                      )}

                      {o.failures.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {o.failures.map((f, i) => (
                            <li key={i} className="text-[10px] text-rose-300">
                              {f}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {results.length === 0 && dryRun === null && !running && (
        <Empty>
          Pick prompts and press <strong>Preview requests</strong> to see exactly what each surface
          would receive, or <strong>Run prompts</strong> to send them.
        </Empty>
      )}
    </div>
  );
}
