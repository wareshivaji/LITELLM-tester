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

export interface Scenario {
  id: string;
  title: string;
  /** What a pass, or a landmine, actually tells you. */
  why: string;
  surface: string;
  body: (ctx: ScenarioContext) => unknown;
  expect: Expectation;
  /**
   * Present when the expectation describes a known defect. The identifier is
   * for cross-referencing with the findings ledger.
   */
  landmine?: string;
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
        id: 'moderations-flat-envelope',
        title: 'Moderations → 501 with a flat, unparseable envelope',
        why: 'LANDMINE-1. A flat {"error":"string"} body defeats every OpenAI SDK, and 501 is retryable so the SDK tries three times.',
        surface: 'moderations',
        body: () => ({ input: 'hello' }),
        landmine: 'LM-1',
        spends: false,
        expect: { status: 501, envelope: 'flat' },
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
        id: 'messages-max-tokens',
        title: 'Anthropic Messages rejects its own mandatory max_tokens',
        why: 'max_tokens is required by the Anthropic API, and on a Bedrock Nova model the gateway forwards it unchanged and Bedrock refuses it.',
        surface: 'messages',
        body: (ctx) => ({
          model: ctx.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        }),
        landmine: 'LM-MSG-MAXTOKENS',
        spends: false,
        expect: { status: 400, envelope: 'anthropic', contains: 'max_tokens' },
      },
      {
        id: 'embeddings-basic',
        title: 'Embeddings returns a vector',
        why: 'A different response shape again, and it needs an embedding model rather than a chat one.',
        surface: 'embeddings',
        body: (ctx) => ({ model: ctx.embedModel, input: 'hello' }),
        spends: true,
        expect: { status: 200, verdict: 'ok', bodyPath: { 'data.0.embedding.0': true } },
      },
      {
        id: 'token-count',
        title: 'Gateway token counter answers without generating',
        why: 'Undocumented, and useful precisely because it costs nothing.',
        surface: 'tokens.count',
        body: (ctx) => chat(ctx),
        spends: false,
        expect: { status: 200, verdict: 'ok', bodyPath: { input_tokens: true } },
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
        surface: 'tokens.count',
        body: () => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }),
        spends: false,
        expect: { status: 403, verdict: 'model-denied', contains: 'not allowed' },
      },
      {
        id: 'gate-applies-off-chat',
        title: 'The allowlist applies on non-generating surfaces too',
        why: 'A gate that only guards the expensive endpoint is not a gate.',
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
  | 'inconclusive'
  | 'error';

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  suiteId: string;
  landmine?: string;
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

  // For a landmine the expectation describes the DEFECT, so matching means the
  // defect is still there, and not matching means something moved.
  const outcome: ScenarioOutcome =
    exchange.transportError !== undefined
      ? 'error'
      : blocked
        ? 'inconclusive'
        : scenario.landmine !== undefined
          ? matched
            ? 'landmine-present'
            : 'landmine-changed'
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
  };
  if (scenario.landmine !== undefined) result.landmine = scenario.landmine;
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
      `${t['landmine-changed']} landmine changed · ${t.inconclusive} inconclusive · ${t.error} error**`,
  );
  lines.push('');
  lines.push('| Target | Scenario | Outcome | HTTP | Verdict | Envelope | Notes |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    const notes = r.failures.length > 0 ? r.failures.join('; ') : '';
    lines.push(
      `| ${r.targetLabel} | ${r.title} | ${r.outcome} | ${r.status ?? '—'} | ${r.verdict} | ${r.envelope} | ${notes} |`,
    );
  }
  lines.push('');
  lines.push(
    '> A `landmine-present` row is the expected state for a known defect. A `landmine-changed` row means the behaviour moved — check whether it was fixed. An `inconclusive` row means the target refused the request outright (bad key for that gateway, or a 5xx), so the scenario never got to ask its question.',
  );
  return lines.join('\n');
}
