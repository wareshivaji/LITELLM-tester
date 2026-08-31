import { useState } from 'react';

import { TOOL_PRESETS } from '@tokenshield/client';
import type { AuthScheme, Exchange, ModelInfo, ToolTurn } from '@tokenshield/client';

import { api } from '../api';
import type { McpBrowseResult, ToolLoopResult } from '../api';
import { ExchangeDetail } from '../components/ExchangeDetail';
import { Card, Empty, Json, selectClass, StatusPill, VerdictPill } from '../components/ui';
import type { ModelCatalogue } from '../hooks/useModelCatalogue';

interface ToolsMcpProps {
  profileId: string;
  keyAlias: string | null;
  scheme: AuthScheme;
  onRecorded: () => void;
  catalogue: ModelCatalogue;
}

export function ToolsMcp(props: ToolsMcpProps) {
  const target = { profileId: props.profileId, keyAlias: props.keyAlias, scheme: props.scheme };

  const models = props.catalogue.models;
  const [model, setModel] = useState('');

  // Keep the choice legal as the shared catalogue arrives or the key changes.
  if (models.length > 0 && !models.some((m) => m.id === model)) {
    setModel(models[0]?.id ?? '');
  }

  return (
    <div className="space-y-5">
      <ToolLoopCard
        target={target}
        models={models}
        model={model}
        onModel={setModel}
        onRecorded={props.onRecorded}
      />
      <McpCard target={target} onRecorded={props.onRecorded} />
    </div>
  );
}

// ── Client-declared tools ────────────────────────────────────────────────────

function ToolLoopCard({
  target,
  models,
  model,
  onModel,
  onRecorded,
}: {
  target: { profileId: string; keyAlias: string | null; scheme: AuthScheme };
  models: ModelInfo[];
  model: string;
  onModel: (m: string) => void;
  onRecorded: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(['get_weather']);
  const [prompt, setPrompt] = useState('What is the weather in Paris?');
  const [toolChoice, setToolChoice] = useState('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolLoopResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function run(): void {
    setBusy(true);
    setError(null);
    setResult(null);
    api
      .toolLoop({ ...target, model, prompt, tools: selected, toolChoice })
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusy(false);
        onRecorded();
      });
  }

  return (
    <Card
      title="Client-declared tools"
      subtitle="One reply, two or three HTTP requests. The question is whether the client's own tool call ever reaches the client."
      right={<StatusPill status="warn" label="spends" />}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
            Model
          </span>
          <select
            className={selectClass}
            value={model}
            onChange={(e) => onModel(e.target.value)}
            disabled={models.length === 0}
          >
            {models.length === 0 && <option value="">— none loaded —</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>

        <label className="block lg:col-span-2">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
            Prompt
          </span>
          <input className={selectClass} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-500">
            tool_choice
          </span>
          <select
            className={selectClass}
            value={toolChoice}
            onChange={(e) => setToolChoice(e.target.value)}
          >
            <option value="auto">auto</option>
            <option value="none">none</option>
            <option value="required">required</option>
            {TOOL_PRESETS.map((t) => (
              <option key={t.id} value={t.id}>
                force {t.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Tools offered
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TOOL_PRESETS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.why}
              onClick={() => toggle(t.id)}
              className={`mono rounded-md border px-2.5 py-1 text-xs ${
                selected.includes(t.id)
                  ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || model.length === 0 || selected.length === 0}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? 'Running the loop…' : 'Run tool loop'}
        </button>
        <span className="text-xs text-zinc-600">
          up to two model calls — the offer, then the results
        </span>
      </div>

      {error !== null && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}

      {result !== null && <ToolLoopReport result={result} />}
    </Card>
  );
}

function ToolLoopReport({ result }: { result: ToolLoopResult }) {
  const allIssues = result.turns.flatMap((t) => t.issues);
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {result.swallowed ? (
          <StatusPill status="fail" label="call swallowed" />
        ) : result.calledNothing ? (
          <StatusPill status="warn" label="model called no tool" />
        ) : (
          <StatusPill status="pass" label="round trip completed" />
        )}
        <span className="text-xs text-zinc-500">
          {result.turns.length} turn(s) · offered {result.offered.join(', ')}
        </span>
      </div>

      {result.swallowed && (
        <p className="rounded-md border border-rose-900/60 bg-rose-950/20 px-3 py-2 text-xs text-rose-200">
          The model was offered these tools, made no call the client can see, and the reply reads
          like the gateway&rsquo;s own &ldquo;unknown tool&rdquo; answer. That is the MCP loop
          resolving a client-declared tool on the model&rsquo;s behalf instead of handing it back —
          which makes client tools unusable for this org without anything returning an error.
        </p>
      )}

      {allIssues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {allIssues.map((i, n) => (
            <li
              key={`${i.call}-${n}`}
              className="rounded-md border border-amber-900/50 bg-amber-950/15 px-2.5 py-1.5 text-amber-200/90"
            >
              <span className="mono text-amber-500/70">{i.call}</span> — {i.issue}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        {result.turns.map((turn) => (
          <TurnRow key={turn.exchangeId} turn={turn} />
        ))}
      </div>

      {result.executed.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
            Executed locally
          </div>
          <Json value={result.executed} maxHeight={140} />
        </div>
      )}

      {result.finalText !== null && (
        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600">Final answer</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-100">{result.finalText}</p>
        </div>
      )}
    </div>
  );
}

function TurnRow({ turn }: { turn: ToolTurn }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Exchange | null>(null);

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next && detail === null) {
      api
        .exchange(turn.exchangeId)
        .then(setDetail)
        .catch(() => setDetail(null));
    }
  }

  return (
    <div className="rounded-md border border-zinc-800">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-xs hover:bg-zinc-900/50"
      >
        <span className="mono text-zinc-600">turn {turn.index}</span>
        <span className="text-zinc-400">
          {turn.kind === 'request' ? 'offer tools' : 'send results'}
        </span>
        <span className="mono text-zinc-300">{turn.status ?? '—'}</span>
        <VerdictPill kind={turn.verdictKind as never} />
        {turn.finishReason !== undefined && (
          <span className="mono text-zinc-500">finish: {turn.finishReason}</span>
        )}
        <span className="mono text-zinc-500">
          {turn.toolCalls.length} call{turn.toolCalls.length === 1 ? '' : 's'}
        </span>
        <span className="mono ml-auto text-zinc-600">{turn.totalMs} ms</span>
      </button>

      {turn.toolCalls.length > 0 && (
        <div className="border-t border-zinc-800/60 px-3 py-2">
          {turn.toolCalls.map((c, i) => (
            <div key={`${c.id}-${i}`} className="mono text-[11px] text-zinc-400">
              <span className="text-sky-300">{c.name}</span>
              <span className="text-zinc-600"> id={c.id || '(none)'} </span>
              <span className="text-zinc-500">{c.argumentsText}</span>
            </div>
          ))}
        </div>
      )}

      {open && detail !== null && <ExchangeDetail exchange={detail} />}
    </div>
  );
}

// ── MCP ──────────────────────────────────────────────────────────────────────

function McpCard({
  target,
  onRecorded,
}: {
  target: { profileId: string; keyAlias: string | null; scheme: AuthScheme };
  onRecorded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpBrowseResult | null>(null);
  const [aggregate, setAggregate] = useState<Exchange | null>(null);
  const [error, setError] = useState<string | null>(null);

  function browse(): void {
    setBusy(true);
    setError(null);
    api
      .mcpBrowse(target)
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusy(false);
        onRecorded();
      });
  }

  function callAggregate(): void {
    setBusy(true);
    setError(null);
    api
      .mcpAggregate(target)
      .then(setAggregate)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        setBusy(false);
        onRecorded();
      });
  }

  return (
    <Card
      title="MCP"
      subtitle="What this key can see and invoke. Free — no provider involved."
      right={<StatusPill status="pass" label="free" />}
    >
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={browse}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-40"
        >
          {busy ? 'Loading…' : 'List servers & tools'}
        </button>
        <button
          type="button"
          onClick={callAggregate}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-600 disabled:opacity-40"
        >
          tools/list via POST /v1/mcp
        </button>
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        The aggregate endpoint is what Cursor, Claude Desktop and the MCP SDKs speak. Locally it
        needs <span className="mono">MCP_TEST_ALLOW_HOSTS</span> set — that variable is default-deny,
        so an empty value looks like &ldquo;MCP is broken&rdquo; rather than &ldquo;no hosts
        allowed&rdquo;.
      </p>

      {error !== null && <p className="mt-3 text-xs text-rose-400">{error}</p>}

      {result !== null && (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
              GET /v1/mcp/servers
              <span className="mono text-zinc-500">{result.servers.status ?? '—'}</span>
              <VerdictPill kind={result.servers.verdict.kind} />
            </div>
            <Json value={result.servers.body} maxHeight={260} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
              GET /v1/mcp/tools
              <span className="mono text-zinc-500">{result.tools.status ?? '—'}</span>
              <VerdictPill kind={result.tools.verdict.kind} />
            </div>
            <Json value={result.tools.body} maxHeight={260} />
          </div>
        </div>
      )}

      {aggregate !== null && (
        <div className="mt-4">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
            POST /v1/mcp · tools/list
            <span className="mono text-zinc-500">{aggregate.response?.status ?? '—'}</span>
            <VerdictPill kind={aggregate.verdict.kind} />
            {aggregate.gateway.mcpSessionId !== undefined && (
              <span className="mono text-sky-300">
                Mcp-Session-Id: {aggregate.gateway.mcpSessionId}
              </span>
            )}
          </div>
          <Json value={aggregate.response?.body ?? aggregate.response?.bodyText} maxHeight={240} />
        </div>
      )}

      {result === null && aggregate === null && (
        <Empty>Nothing loaded yet.</Empty>
      )}
    </Card>
  );
}
