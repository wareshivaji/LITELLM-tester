/**
 * Declarative scenarios — the same questions, asked the same way, every time.
 *
 * The Playground answers "what does this do?". A scenario answers "is it still
 * doing what it did last week?", which needs the question written down rather
 * than retyped. Each one is a request plus an expectation, and the expectation
 * is the part that carries the knowledge.
 *
 * **Landmines invert the meaning of a pass.** A scenario marked `landmine`
 * describes behaviour believed to be *wrong today*, so its expectation matching
 * means the bug is still there — reported as `landmine-present`, not as a
 * success. When it stops matching, something changed and a human should look:
 * `landmine-changed`. That is the same signal the Python suite gets from an
 * XPASS under `xfail(strict=True)`, and it is why a suite that goes all-green
 * would actually be suspicious.
 */

import type { ErrorEnvelope, Exchange, VerdictKind } from './types.js';

export interface ScenarioContext {
  /** A cheap chat-capable model from the key's catalogue. */
  model: string;
  /** An embedding model, for the surfaces that need one. */
  embedModel: string;
}

export interface Expectation {
  /** A single status, or any one of several. */
  status?: number | number[];
  verdict?: VerdictKind;
  envelope?: ErrorEnvelope;
  /** Response headers that must be present. */
  headers?: string[];
  /** Case-insensitive substring of the response text. */
  contains?: string;
  /** Dotted paths into the parsed body. `true` means "must exist". */
  bodyPath?: Record<string, unknown>;
}

/**
 * Where an expectation comes from — which is the difference between "the
 * gateway is wrong" and "we assumed something".
 *
 * `measured` is the weakest: it only says the gateway did this once. It cannot
 * tell you the behaviour is *correct*, so a `measured` expectation that starts
 * failing means something changed, not necessarily that something broke.
 */
export type ExpectationSource =
  /** OpenAI's published API behaviour — the contract clients are written to. */
  | 'openai'
  /** The MCP specification itself: handshake order, JSON-RPC result shapes. */
  | 'mcp-spec'
  /**
   * LiteLLM, the compatibility target this gateway is measured against.
   *
   * NOT verified against a local LiteLLM source or package — neither is
   * installed here — so these are from documented behaviour and should be
   * confirmed against a real LiteLLM before being treated as authoritative.
   */
  | 'litellm'
  /**
   * A CloudGov-specific feature with no external equivalent.
   *
   * CORRECTED 2026-09-01. This originally said per-key tool blocking was the
   * example, because LiteLLM had no such concept. Reading the actual LiteLLM
   * source proved that wrong: it has `mcp_tool_permissions` at both key and
   * team level, `allowed_tools` AND `disallowed_tools`, and it intersects team
   * with key so the narrower wins — the same principle as our org/key rule.
   *
   * So tool governance is NOT what this value is for; `litellm` is a valid
   * reference for that. What is genuinely CloudGov-only is narrower: a single
   * stored policy enum (`ALWAYS_ALLOW`/`BLOCK`) that means a blacklist at org
   * level and an allow-list at key level, and the fail-open default for a key
   * that says nothing. LiteLLM models the same governance as explicit
   * allow/deny lists, which has no such dual reading.
   *
   * What *is* testable from the client side is the compatibility invariant:
   * enforcing the policy must not change the shape of what a client sends or
   * parses. On the advertising path that holds by construction — a blocked
   * tool is not listed, so the client never calls it and the wire is
   * untouched. The exception is a client that calls a blocked tool anyway,
   * from a stale tool list or by declaring the name itself: that refusal *is*
   * client-visible, and its envelope is a real contract question.
   *
   * Everything else about the policy is gateway-side accounting, which is
   * monitored on the gateway rather than asserted from here.
   */
  | 'cloudgov'
  /** Only what this gateway was observed doing. Weakest form. */
  | 'measured';

export interface Scenario {
  id: string;
  title: string;
  /** What a pass, or a landmine, actually tells you. */
  why: string;
  surface: string;
  body: (ctx: ScenarioContext) => unknown;
  expect: Expectation;
  /** Where the expectation comes from. Defaults to `measured`. */
  reference?: ExpectationSource;
  /**
   * Present when the expectation describes a known defect in finished code.
   * The identifier cross-references the findings ledger.
   */
  landmine?: string;
  /**
   * Present when the expectation describes behaviour the gateway is **not
   * finished implementing**, so the expectation states the TARGET rather than
   * the defect.
   *
   * Deliberately not a landmine. A landmine says "this code is done and wrong",
   * which reads as a regression and belongs in a bug report. Unfinished work is
   * a different thing: reporting it as a failure makes an in-progress feature
   * look broken, and reporting it as a landmine makes it look like a defect
   * somebody introduced. It gets its own outcome so a suite can be read
   * honestly while the work is still landing — and when it starts passing, the
   * feature arrived and this marker should come off.
   */
  notImplemented?: string;
  /** Whether running it reaches a provider. */
  spends: boolean;
  /** Send with no credential, whatever the selected key is. */
  unauthenticated?: boolean;
}

export interface Suite {
  id: string;
  title: string;
  description: string;
  scenarios: Scenario[];
}

const chat = (ctx: ScenarioContext, extra: Record<string, unknown> = {}): unknown => ({
  model: ctx.model,
  messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  max_tokens: 16,
  ...extra,
});

export const SUITES: readonly Suite[] = [
  {
    id: 'conformance',
    title: 'Client conformance',
    description:
      'What an OpenAI-compatible client is entitled to assume. Mostly free — these are rejections, not generations.',
    scenarios: [
      {
        id: 'auth-401',
        title: 'No credential → 401 in an OpenAI envelope',
        why: 'The front door. An SDK must be able to parse this to tell the developer their key is wrong.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx),
        unauthenticated: true,
        spends: false,
        expect: { status: 401, verdict: 'auth', envelope: 'openai' },
      },
      {
        id: 'unknown-model',
        title: 'Unroutable model → clean 4xx naming it',
        why: 'Should be a parseable client error, not a 500 and not a silent fallback.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx, { model: 'no-such-model-in-any-catalogue' }),
        spends: false,
        expect: { status: [400, 404], verdict: 'not-found', contains: 'no-such-model' },
      },
      {
        id: 'empty-messages',
        title: 'Empty messages array → 400',
        why: 'A degenerate request should be refused, ideally by the gateway rather than the provider.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx, { messages: [] }),
        spends: false,
        expect: { status: 400, verdict: 'bad-request' },
      },
      {
        id: 'stop-as-string',
        title: 'stop as a string → 400',
        why: 'OpenAI accepts a bare string. The gateway turns it into a blank stop sequence and the provider refuses.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx, { stop: '\n\n' }),
        landmine: 'LM-3',
        spends: false,
        expect: { status: 400, verdict: 'bad-request' },
      },
      {
        id: 'content-as-array',
        title: 'content as an array of parts → 200',
        why: 'Was LANDMINE-2 and is fixed. Kept so a regression is caught rather than rediscovered.',
        surface: 'chat.completions',
        body: (ctx) => ({
          model: ctx.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
          max_tokens: 16,
        }),
        spends: true,
        expect: { status: 200, verdict: 'ok' },
      },
      {
        id: 'unknown-param-ignored',
        title: 'Unrecognised parameter is ignored, not rejected',
        why: 'Forward compatibility: a client on a newer SDK must not be broken by a field the gateway has not heard of.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx, { cg_lab_not_a_real_param: true }),
        spends: true,
        expect: { status: 200, verdict: 'ok' },
      },
    ],
  },
  {
    id: 'surfaces',
    title: 'Surfaces',
    description: 'Does each endpoint work at all, and does its response read the way its shape promises?',
    scenarios: [
      {
        id: 'chat-basic',
        title: 'Chat completions returns text',
        why: 'The call almost every customer makes.',
        surface: 'chat.completions',
        body: (ctx) => chat(ctx),
        spends: true,
        expect: {
          status: 200,
          verdict: 'ok',
          headers: ['x-request-id'],
          bodyPath: { 'choices.0.message.content': true, 'usage.total_tokens': true },
        },
      },
      {
        id: 'responses-basic',
        title: 'Responses returns output',
        why: "OpenAI's newer surface, with a different response shape the client must read.",
        surface: 'responses',
        body: (ctx) => ({ model: ctx.model, input: 'Reply with exactly: pong', max_output_tokens: 32 }),
        spends: true,
        expect: { status: 200, verdict: 'ok', bodyPath: { 'output.0': true } },
      },
      {
        id: 'responses-shorthand-continuation',
        title: 'Responses drops a shorthand user turn once tool items are present',
        why: "OpenAI's documented tool-continuation uses the shorthand `{role, content}` input item. The gateway accepts it alone, drops it when tool items follow, and then reports \"must start with a user message\" about a request that starts with one. Any client following the documented pattern hits this, and the error sends them looking for something that is already there.",
        surface: 'responses',
        body: (ctx) => ({
          model: ctx.model,
          max_output_tokens: 64,
          input: [
            { role: 'user', content: 'What is the weather in Paris?' },
            {
              type: 'function_call',
              call_id: 'call_scenario_1',
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
            {
              type: 'function_call_output',
              call_id: 'call_scenario_1',
              output: '{"temperature_c":21}',
            },
          ],
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get the current temperature for a city.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        }),
        reference: 'openai',
        notImplemented:
          'The gateway accepts the shorthand item alone but drops it once tool items follow, then reports "must start with a user message" about a request that starts with one. Workaround: the explicit message item, which the paired scenario below proves works.',
        spends: false,
        // The expectation states what OpenAI does, not what the gateway does.
        // While the MCP/Responses work is unfinished this reports
        // `not-implemented` rather than a failure; when it turns `pass`, the
        // shorthand form is being honoured and this marker comes off.
        expect: { status: 200, verdict: 'ok' },
      },
      {
        id: 'responses-explicit-continuation',
        title: 'The same continuation with an explicit message item is accepted',
        why: 'The other half of the pair, and the workaround. Proves the tool items are fine and the shorthand user turn is what gets dropped — without it, the failure above looks like a problem with the tool items.',
        reference: 'openai',
        surface: 'responses',
        body: (ctx) => ({
          model: ctx.model,
          max_output_tokens: 64,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'What is the weather in Paris?' }],
            },
            {
              type: 'function_call',
              call_id: 'call_scenario_2',
              name: 'get_weather',
              arguments: '{"city":"Paris"}',
            },
            {
              type: 'function_call_output',
              call_id: 'call_scenario_2',
              output: '{"temperature_c":21}',
            },
          ],
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get the current temperature for a city.',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        }),
        spends: true,
        expect: { status: 200, verdict: 'ok' },
      },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP',
    description:
      'The MCP surface, measured against the MCP specification rather than against what this gateway currently does — the implementation is still landing, so a `not-implemented` row here is the expected state and not a defect. All free. Per-tool policy and x-mcp-servers scoping need at least one configured server and are not asserted here.',
    scenarios: [
      {
        id: 'mcp-tools-list-shape',
        title: 'tools/list answers a JSON-RPC result with a tools array',
        why: 'The shape every off-the-shelf MCP client reads. An empty array is a valid answer; a missing `result.tools` is not, because a client cannot tell "no tools" from "malformed reply".',
        surface: 'mcp.aggregate',
        body: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        reference: 'mcp-spec',
        spends: false,
        expect: { status: 200, bodyPath: { 'result.tools': true } },
      },
      {
        id: 'mcp-session-id',
        title: 'The Streamable HTTP endpoint assigns an Mcp-Session-Id',
        why: 'Under the MCP Streamable HTTP transport a server that wants a session assigns the id and the client echoes it on later requests. Measured 2026-08-31 no such header came back, so a client cannot hold a session across calls — every request starts cold.',
        surface: 'mcp.aggregate',
        body: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        reference: 'mcp-spec',
        notImplemented:
          'No Mcp-Session-Id was returned. Session continuity across MCP calls is not available to a client yet.',
        spends: false,
        expect: { status: 200, headers: ['mcp-session-id'] },
      },
      {
        id: 'mcp-servers-listing',
        title: 'The server listing is a well-formed envelope',
        why: 'A console or an agent needs to enumerate entitlement before doing anything else. An empty list is fine; a missing `servers` key is not.',
        surface: 'mcp.servers',
        body: () => ({}),
        reference: 'measured',
        spends: false,
        expect: { status: 200, bodyPath: { servers: true } },
      },
      {
        id: 'mcp-unknown-method',
        title: 'An unknown JSON-RPC method is refused in the JSON-RPC error shape',
        why: 'JSON-RPC says an unknown method returns an `error` object with a code, not an HTTP failure or a bare string. A client dispatching on the error code needs that shape.',
        surface: 'mcp.aggregate',
        body: () => ({ jsonrpc: '2.0', id: 99, method: 'tools/doesNotExist', params: {} }),
        reference: 'mcp-spec',
        spends: false,
        expect: { status: 200, bodyPath: { 'error.code': true } },
      },
    ],
  },
  {
    id: 'governance',
    title: 'Governance gates',
    description: 'The rejections that are supposed to happen. All free — none reaches a provider.',
    scenarios: [
      {
        id: 'model-denied',
        title: 'A model outside the key’s allowlist → 403, named',
        why: 'Must be distinguishable from "no such model", or an operator cannot tell a permission problem from a typo.',
        // tokens.count is an INSTRUMENT, not a tested surface: it resolves and
        // authorises a model without generating anything, so the gate can be
        // exercised for free. See INSTRUMENTS in surfaces.ts.
        surface: 'tokens.count',
        body: () => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        spends: false,
        expect: { status: 403, verdict: 'model-denied', contains: 'not allowed' },
      },
      {
        id: 'gate-applies-off-chat',
        title: 'The allowlist applies on non-generating surfaces too',
        why: 'A gate that only guards the expensive endpoint is not a gate.',
        // tokens.count is an INSTRUMENT, not a tested surface: it resolves and
        // authorises a model without generating anything, so the gate can be
        // exercised for free. See INSTRUMENTS in surfaces.ts.
        surface: 'tokens.count',
        body: () => ({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'x' }] }),
        spends: false,
        expect: { verdict: 'model-denied' },
      },
    ],
  },
];

export function suiteById(id: string): Suite | undefined {
  return SUITES.find((s) => s.id === id);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export type ScenarioOutcome =
  | 'pass'
  | 'fail'
  | 'landmine-present'
  | 'landmine-changed'
  | 'not-implemented'
  | 'inconclusive'
  | 'error';

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  suiteId: string;
  landmine?: string;
  notImplemented?: string;
  reference: ExpectationSource;
  outcome: ScenarioOutcome;
  /** Every expectation that was not met, in words. */
  failures: string[];
  exchangeId: string;
  status: number | null;
  verdict: VerdictKind;
  envelope: ErrorEnvelope;
  totalMs: number;
  /** Which target produced this, when a run covers more than one. */
  targetLabel: string;
}

function valueAtPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Lists every expectation the exchange did not meet. Empty means matched. */
export function checkExpectation(expect: Expectation, exchange: Exchange): string[] {
  const failures: string[] = [];
  const status = exchange.response?.status ?? null;

  if (expect.status !== undefined) {
    const allowed = Array.isArray(expect.status) ? expect.status : [expect.status];
    if (status === null || !allowed.includes(status)) {
      failures.push(`status ${status ?? 'none'}, expected ${allowed.join(' or ')}`);
    }
  }
  if (expect.verdict !== undefined && exchange.verdict.kind !== expect.verdict) {
    failures.push(`verdict ${exchange.verdict.kind}, expected ${expect.verdict}`);
  }
  if (expect.envelope !== undefined && exchange.verdict.envelope !== expect.envelope) {
    failures.push(`envelope ${exchange.verdict.envelope}, expected ${expect.envelope}`);
  }
  for (const header of expect.headers ?? []) {
    if (exchange.response?.headers[header.toLowerCase()] === undefined) {
      failures.push(`missing header ${header}`);
    }
  }
  if (expect.contains !== undefined) {
    const haystack = (exchange.response?.bodyText ?? '').toLowerCase();
    if (!haystack.includes(expect.contains.toLowerCase())) {
      failures.push(`body does not contain "${expect.contains}"`);
    }
  }
  for (const [path, expected] of Object.entries(expect.bodyPath ?? {})) {
    const actual = valueAtPath(exchange.response?.body, path);
    if (expected === true) {
      if (actual === undefined || actual === null) failures.push(`missing ${path}`);
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
  return failures;
}

export function evaluateScenario(
  scenario: Scenario,
  suiteId: string,
  exchange: Exchange,
  targetLabel: string,
): ScenarioResult {
  const failures =
    exchange.transportError !== undefined
      ? [exchange.transportError]
      : checkExpectation(scenario.expect, exchange);
  const matched = failures.length === 0;

  /**
   * The target refused us outright, so the scenario never got to ask its
   * question.
   *
   * This matters most for landmines. Running a suite against a gateway where
   * the key is not valid turns every request into a 401 — and without this
   * check each landmine would be reported `landmine-changed`, which reads as
   * "the bug may be fixed here". It is not: nothing was measured. A scenario
   * that *expects* an auth failure is exempt, since for that one the 401 is
   * the answer rather than an obstacle.
   */
  const blocked =
    scenario.expect.verdict !== 'auth' &&
    (exchange.verdict.kind === 'auth' || exchange.verdict.kind === 'server-error') &&
    !matched;

  // Three different inversions, and conflating them is how a suite stops being
  // readable:
  //
  //  - A landmine expectation describes the DEFECT. Matching means the defect
  //    is still present; not matching means something moved.
  //  - A notImplemented expectation describes the TARGET. Matching means the
  //    feature has landed (a real pass); not matching is the expected state
  //    while the work is in progress, and is not a failure.
  //  - Everything else is an ordinary pass or fail.
  const outcome: ScenarioOutcome =
    exchange.transportError !== undefined
      ? 'error'
      : blocked
        ? 'inconclusive'
        : scenario.landmine !== undefined
          ? matched
            ? 'landmine-present'
            : 'landmine-changed'
          : scenario.notImplemented !== undefined
            ? matched
              ? 'pass'
              : 'not-implemented'
            : matched
              ? 'pass'
              : 'fail';

  const result: ScenarioResult = {
    scenarioId: scenario.id,
    title: scenario.title,
    suiteId,
    outcome,
    failures,
    exchangeId: exchange.id,
    status: exchange.response?.status ?? null,
    verdict: exchange.verdict.kind,
    envelope: exchange.verdict.envelope,
    totalMs: exchange.timings.totalMs,
    targetLabel,
    reference: scenario.reference ?? 'measured',
  };
  if (scenario.landmine !== undefined) result.landmine = scenario.landmine;
  if (scenario.notImplemented !== undefined) result.notImplemented = scenario.notImplemented;
  return result;
}

export interface ScenarioReport {
  suiteId: string;
  suiteTitle: string;
  startedAt: string;
  durationMs: number;
  model: string;
  embedModel: string;
  targets: Array<{ label: string; baseUrl: string; keyAlias: string | null }>;
  results: ScenarioResult[];
  tally: Record<ScenarioOutcome, number>;
}

export function tally(results: readonly ScenarioResult[]): Record<ScenarioOutcome, number> {
  const counts: Record<ScenarioOutcome, number> = {
    pass: 0,
    fail: 0,
    'landmine-present': 0,
    'landmine-changed': 0,
    'not-implemented': 0,
    inconclusive: 0,
    error: 0,
  };
  for (const r of results) counts[r.outcome]++;
  return counts;
}

/**
 * A report a human can read without the console — for a ticket, a findings
 * sheet, or a message to whoever owns the gateway. Every row names the target
 * it came from, because a result without its target is not evidence.
 */
export function reportToMarkdown(report: ScenarioReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.suiteTitle}`);
  lines.push('');
  lines.push(`- Run: ${report.startedAt} (${Math.round(report.durationMs)} ms)`);
  lines.push(`- Model: \`${report.model}\`, embeddings \`${report.embedModel}\``);
  for (const t of report.targets) {
    lines.push(`- Target **${t.label}**: \`${t.baseUrl}\` · key \`${t.keyAlias ?? 'none'}\``);
  }
  lines.push('');
  const t = report.tally;
  lines.push(
    `**${t.pass} pass · ${t.fail} fail · ${t['landmine-present']} landmine still present · ` +
      `${t['landmine-changed']} landmine changed · ${t['not-implemented']} not yet implemented · ` +
      `${t.inconclusive} inconclusive · ${t.error} error**`,
  );
  lines.push('');
  lines.push('| Target | Scenario | Outcome | Ref | HTTP | Verdict | Envelope | Notes |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    const notes = r.failures.length > 0 ? r.failures.join('; ') : '';
    lines.push(
      `| ${r.targetLabel} | ${r.title} | ${r.outcome} | ${r.reference} | ${r.status ?? '—'} | ${r.verdict} | ${r.envelope} | ${notes} |`,
    );
  }
  lines.push('');
  lines.push(
    '> A `landmine-present` row is the expected state for a known defect. A `landmine-changed` row means the behaviour moved — check whether it was fixed. A `not-implemented` row is the expected state for a feature still being built: the expectation states the target, and when such a row turns `pass` the feature has landed. An `inconclusive` row means the target refused the request outright (bad key for that gateway, or a 5xx), so the scenario never got to ask its question.',
  );
  lines.push('');
  lines.push(
    '> The `Ref` column is where each expectation comes from. `openai` and `mcp-spec` are published contracts. `litellm` is the compatibility target but is **not** verified against a local LiteLLM here — treat those as documented behaviour pending confirmation. `measured` only records what this gateway was observed doing once, and cannot tell you that behaviour is correct.',
  );
  return lines.join('\n');
}
