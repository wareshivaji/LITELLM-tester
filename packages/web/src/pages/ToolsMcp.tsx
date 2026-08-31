import { useState } from 'react';

import { tallyPolicies, TOOL_PRESETS } from '@tokenshield/client';
import type { McpPolicy, McpTool } from '@tokenshield/client';
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
  const [surfaceId, setSurfaceId] = useState('chat.completions');
  const [wrongShape, setWrongShape] = useState(false);
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
      .toolLoop({ ...target, model, prompt, tools: selected, toolChoice, surfaceId, wrongToolShape: wrongShape })
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
          Surface
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['chat.completions', 'responses'] as const).map((sid) => (
            <button
              key={sid}
              type="button"
              onClick={() => setSurfaceId(sid)}
              className={`mono rounded-md border px-2.5 py-1 text-xs ${
                surfaceId === sid
                  ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-600'
              }`}
            >
              {sid === 'responses' ? '/v1/responses' : '/v1/chat/completions'}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={wrongShape}
              onChange={(e) => setWrongShape(e.target.checked)}
              className="accent-amber-600"
            />
            send the other surface&rsquo;s tool shape
          </label>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
          Chat declares a tool nested under <span className="mono">function</span>; Responses
          declares it flat, with <span className="mono">name</span> at the top level. The gateway
          reads the name from a different place on each, so reusing a chat definition on Responses
          declares a tool whose name it cannot see. Tick the box to do that deliberately.
        </p>
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
          <span className="mono">{result.surfaceId}</span> · {result.turns.length} turn(s) · offered{' '}
          {result.offered.join(', ')}
          {result.wrongToolShape && (
            <span className="ml-1 rounded bg-amber-500/10 px-1 text-amber-300">wrong shape</span>
          )}
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
  const [testResult, setTestResult] = useState<Exchange | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onTest(server: string): void {
    setError(null);
    setTestResult(null);
    api
      .mcpTest({ ...target, server })
      .then(setTestResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(onRecorded);
  }

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
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
            GET /v1/mcp/servers
            <span className="mono text-zinc-500">{result.servers.status ?? '—'}</span>
            <VerdictPill kind={result.servers.verdict.kind} />
            <span className="text-zinc-700">·</span>
            GET /v1/mcp/tools
            <span className="mono text-zinc-500">{result.tools.status ?? '—'}</span>
            <VerdictPill kind={result.tools.verdict.kind} />
          </div>

          {result.servers.parsed.length === 0 && result.tools.parsed.length === 0 ? (
            <div className="rounded-md border border-amber-900/50 bg-amber-950/15 px-3 py-2 text-xs text-amber-200/90">
              This key sees no MCP servers. Note that this endpoint cannot tell you which of two
              very different things that means: none are configured, or some are configured and
              discovery failed. Both answer with an empty list and a 200.
            </div>
          ) : (
            <>
              <PolicySummary tools={result.tools.parsed} />
              {result.servers.parsed.map((server) => (
                <div key={server.id} className="rounded-md border border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
                    <span className="text-zinc-200">{server.name}</span>
                    <span className="mono text-[10px] text-zinc-600">{server.id}</span>
                    <span className="mono rounded bg-zinc-900 px-1.5 text-[10px] text-zinc-400">
                      {server.transport}
                    </span>
                    <span className="text-[10px] text-zinc-600">{server.tools.length} tool(s)</span>
                    <button
                      type="button"
                      onClick={() => onTest(server.id)}
                      className="ml-auto rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-300 hover:border-zinc-600"
                    >
                      test reachability
                    </button>
                  </div>
                  {server.tools.length > 0 && (
                    <table className="w-full text-left text-[11px]">
                      <tbody>
                        {server.tools.map((t) => (
                          <tr key={t.name} className="border-t border-zinc-800/60">
                            <td className="mono px-3 py-1 text-zinc-300">{t.name}</td>
                            <td className="px-3 py-1">
                              <PolicyPill policy={t.policy} />
                            </td>
                            <td className="px-3 py-1 text-zinc-600">
                              {(t.description ?? '').slice(0, 80)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </>
          )}

          <details>
            <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
              raw responses
            </summary>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              <Json value={result.servers.body} maxHeight={220} collapsedByDefault />
              <Json value={result.tools.body} maxHeight={220} collapsedByDefault />
            </div>
          </details>
        </div>
      )}

      {testResult !== null && (
        <div className="mt-4">
          <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600">
            POST /v1/mcp/servers/test
            <span className="mono text-zinc-500">{testResult.response?.status ?? '—'}</span>
            <VerdictPill kind={testResult.verdict.kind} />
          </div>
          <Json value={testResult.response?.body ?? testResult.response?.bodyText} maxHeight={200} />
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


// ── MCP policy ───────────────────────────────────────────────────────────────

const POLICY_TONE: Record<McpPolicy, string> = {
  allow: 'bg-emerald-500/10 text-emerald-300',
  ask: 'bg-amber-500/10 text-amber-300',
  block: 'bg-rose-500/10 text-rose-300',
  unknown: 'bg-zinc-700/40 text-zinc-400',
};

function PolicyPill({ policy }: { policy: McpPolicy }) {
  return (
    <span className={`mono rounded px-1.5 py-0.5 text-[10px] ${POLICY_TONE[policy]}`}>{policy}</span>
  );
}

/**
 * The counts, and the thing worth knowing about them.
 *
 * A tool being advertised is not the same as a tool being usable — the list
 * endpoint returns blocked tools too, with their policy attached. And `ask` is
 * a value the API still advertises although the gateway's enforcement model no
 * longer has an ask state, so a client branching on it is coding against
 * something nothing should produce.
 */
function PolicySummary({ tools }: { tools: McpTool[] }) {
  const t = tallyPolicies(tools);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500">{t.total} tool(s) reachable by this key:</span>
        <PolicyPill policy="allow" />
        <span className="mono text-zinc-300">{t.allow}</span>
        <PolicyPill policy="block" />
        <span className="mono text-zinc-300">{t.block}</span>
        {t.ask > 0 && (
          <>
            <PolicyPill policy="ask" />
            <span className="mono text-zinc-300">{t.ask}</span>
          </>
        )}
        {t.unknown > 0 && (
          <>
            <PolicyPill policy="unknown" />
            <span className="mono text-zinc-300">{t.unknown}</span>
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
        Advertised is not the same as usable — a <span className="mono">block</span> tool still
        appears in the listing, with its policy attached.
        {t.ask > 0 && (
          <>
            {' '}
            <span className="text-amber-400">
              An <span className="mono">ask</span> policy is worth a second look: the gateway
              advertises that value but its enforcement model no longer has an ask state, so it is
              not clear what actually happens when such a tool is called.
            </span>
          </>
        )}
      </p>
    </div>
  );
}
