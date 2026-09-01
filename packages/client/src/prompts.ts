/**
 * Prompt-based testing across `/v1/chat/completions` and `/v1/responses`.
 *
 * ## Why this is separate from scenarios
 *
 * A scenario asserts on the HTTP envelope: status, error shape, headers. That
 * catches compatibility breaks but says nothing about whether the thing
 * actually *worked* — a 200 carrying a refusal is still a 200.
 *
 * This module asserts on **behaviour**: what came back, whether a tool ran,
 * whether the answer is usable. And it asks the question a scenario cannot:
 * does the same prompt behave the same way on both surfaces?
 *
 * ## The problem it solves
 *
 * The two surfaces disagree about everything except the model. A user turn is
 * `messages: [{role, content}]` on one and `input: [{type:'message', role,
 * content:[{type:'input_text', text}]}]` on the other. The answer is
 * `choices[0].message.content` on one and an `output[]` array on the other.
 * Tool calls live in completely different places.
 *
 * So a customer moving from chat completions to responses has to rewrite both
 * ends and has no way to check they got the same behaviour. That is exactly
 * what this compares: one prompt, two request shapes, two readers, one
 * normalised answer.
 *
 * ## Cost
 *
 * Every prompt case reaches a provider — that is the point, and it cannot be
 * faked. `maxTokens` is deliberately small and every case declares its own, so
 * the bill is bounded and visible before anything runs.
 */

import type { Exchange } from './types.js';
import { extractResponsesToolCalls, extractToolCalls, type ToolCall } from './tools.js';

/** The surfaces prompt testing covers. Deliberately only these two. */
export const PROMPT_SURFACES = ['chat.completions', 'responses'] as const;
export type PromptSurfaceId = (typeof PROMPT_SURFACES)[number];

/**
 * What a prompt case expects of the *answer*, not of the envelope.
 *
 * Every field is optional and every one that is set must hold. An empty
 * expectation is legal and means "just don't fail" — useful for a smoke prompt
 * where the interesting part is the cross-surface comparison.
 */
export interface PromptExpectation {
  /** Case-insensitive substrings the answer must contain. */
  mentions?: string[];
  /** Case-insensitive substrings the answer must NOT contain. */
  absent?: string[];
  /** The answer must parse as JSON. */
  jsonParses?: boolean;
  /** A tool call with this name must be made. */
  callsTool?: string;
  /** No tool call at all. */
  noToolCalls?: boolean;
  /** The answer must be non-empty after trimming. */
  nonEmpty?: boolean;
  /**
   * The two surfaces must agree.
   *
   * Not string equality — models are not deterministic and demanding identical
   * text would fail constantly for no reason. It compares the things a client
   * depends on: whether a tool was called, which tool, and whether an answer
   * came back at all.
   */
  agreesAcrossSurfaces?: boolean;
}

export interface PromptCase {
  id: string;
  title: string;
  /** What this prompt is actually probing, and what a failure would mean. */
  why: string;
  prompt: string;
  /** A system instruction, when the case needs one to be meaningful. */
  system?: string;
  expect: PromptExpectation;
  /** Cap per surface. Small on purpose. */
  maxTokens: number;
  /** Declare the lab's own MCP server as a tool on this request. */
  useMcp?: boolean;
  /** Declare these client-side function tools. */
  tools?: 'weather' | 'none';
}

/** The client-side tool used by the tool-calling prompts. */
const WEATHER_TOOL_CHAT = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
} as const;

/** The same tool in the Responses flat shape. Not interchangeable. */
const WEATHER_TOOL_RESPONSES = {
  type: 'function',
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
} as const;

/**
 * The MCP tool block.
 *
 * Same shape on both surfaces — per <https://docs.litellm.ai/docs/mcp>, LiteLLM
 * accepts `{type:"mcp"}` on chat completions as well as responses, and the
 * OpenAI Responses type has the same required fields. That is convenient here
 * and is itself worth confirming: if one surface rejects it, they have diverged.
 */
export function mcpToolBlock(serverUrl: string): Record<string, unknown> {
  return {
    type: 'mcp',
    server_label: 'tokenshield_lab',
    server_url: serverUrl,
    require_approval: 'never',
  };
}

export const PROMPT_CASES: readonly PromptCase[] = [
  {
    id: 'smoke',
    title: 'Plain answer, both surfaces',
    why: 'The baseline. If this differs between surfaces, nothing below is interpretable — and a client migrating between them is already in trouble.',
    prompt: 'Reply with exactly the word: ready',
    expect: { nonEmpty: true, mentions: ['ready'], noToolCalls: true, agreesAcrossSurfaces: true },
    maxTokens: 16,
    tools: 'none',
  },
  {
    id: 'system-honoured',
    title: 'A system instruction is applied',
    why: 'The two surfaces carry system text differently. If one drops it, a customer\'s guardrails and persona silently stop applying on that surface — which looks like a model problem, not a gateway one.',
    system: 'You must answer every question with exactly one word, in lowercase.',
    prompt: 'What colour is a clear midday sky?',
    expect: { nonEmpty: true, agreesAcrossSurfaces: true },
    maxTokens: 16,
    tools: 'none',
  },
  {
    id: 'json-mode',
    title: 'Structured output survives',
    why: 'Asking for JSON is the most common real use. A surface that wraps or prefixes the answer breaks every caller that does JSON.parse.',
    prompt: 'Return only a JSON object with keys "city" and "country" for Paris. No prose, no code fence.',
    expect: { jsonParses: true, noToolCalls: true },
    maxTokens: 64,
    tools: 'none',
  },
  {
    id: 'tool-offered',
    title: 'A client-declared tool is offered back',
    why: 'The gateway must hand a client-declared tool back to the client rather than executing it. Different tool shapes per surface, so this also proves the gateway reads each one.',
    prompt: 'What is the weather in Paris? Use the tool.',
    expect: { callsTool: 'get_weather', agreesAcrossSurfaces: true },
    maxTokens: 128,
    tools: 'weather',
  },
  {
    id: 'tool-not-forced',
    title: 'A tool is available but not needed',
    why: 'A tool being declared must not compel its use. A surface that always calls the tool burns a round trip on every unrelated question.',
    prompt: 'Say hello in French. Do not use any tool.',
    expect: { noToolCalls: true, nonEmpty: true, agreesAcrossSurfaces: true },
    maxTokens: 32,
    tools: 'weather',
  },
  {
    id: 'mcp-brokered',
    title: 'An MCP tool actually runs',
    why: "Points at the lab's own MCP server. Its answer is deliberately absurd — no model could invent it — so if the phrase comes back, the gateway genuinely brokered the call rather than hallucinating an answer.",
    prompt: 'Use the lab_weather tool to check the weather in Paris, then tell me exactly what it said.',
    expect: { mentions: ['raining upward'], nonEmpty: true },
    maxTokens: 160,
    useMcp: true,
    tools: 'none',
  },
  {
    id: 'mcp-and-client-tools',
    title: 'MCP and a client tool in one request',
    why: 'The mixed case, prod-confirmed to deadlock. The gateway must broker its own tool and hand back the client one; swallowing either is a hang or a wrong answer.',
    prompt: 'Check the weather in Paris using whichever tool is appropriate.',
    expect: { nonEmpty: true },
    maxTokens: 160,
    useMcp: true,
    tools: 'weather',
  },
];

/** Options for building a request body from a case. */
export interface BuildOptions {
  model: string;
  /** Where the lab's own MCP server is, for cases with `useMcp`. */
  mcpServerUrl?: string;
  /** Force streaming. */
  stream?: boolean;
}

/**
 * Turn one prompt case into the body a given surface expects.
 *
 * This is the whole point of the module: the same intent, expressed two
 * different ways, so a difference in the answer is a difference in the gateway
 * rather than a difference in what was asked.
 */
export function buildPromptBody(
  surface: PromptSurfaceId,
  promptCase: PromptCase,
  opts: BuildOptions,
): Record<string, unknown> {
  const tools: unknown[] = [];
  if (promptCase.tools === 'weather') {
    tools.push(surface === 'responses' ? WEATHER_TOOL_RESPONSES : WEATHER_TOOL_CHAT);
  }
  if (promptCase.useMcp === true && opts.mcpServerUrl !== undefined) {
    tools.push(mcpToolBlock(opts.mcpServerUrl));
  }

  if (surface === 'chat.completions') {
    const messages: unknown[] = [];
    if (promptCase.system !== undefined) {
      messages.push({ role: 'system', content: promptCase.system });
    }
    messages.push({ role: 'user', content: promptCase.prompt });
    return {
      model: opts.model,
      messages,
      max_tokens: promptCase.maxTokens,
      ...(tools.length > 0 ? { tools } : {}),
      ...(opts.stream === true ? { stream: true } : {}),
    };
  }

  // Responses. The EXPLICIT message item, not the shorthand `{role, content}`:
  // the gateway drops the shorthand once tool items are present, and using one
  // form here and another elsewhere would make results incomparable.
  const input: unknown[] = [];
  if (promptCase.system !== undefined) {
    input.push({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: promptCase.system }],
    });
  }
  input.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: promptCase.prompt }],
  });
  return {
    model: opts.model,
    input,
    max_output_tokens: promptCase.maxTokens,
    ...(tools.length > 0 ? { tools } : {}),
    ...(opts.stream === true ? { stream: true } : {}),
  };
}

/** What one surface actually did, in a shape both surfaces can produce. */
export interface PromptOutcome {
  surface: PromptSurfaceId;
  exchangeId: string;
  status: number | null;
  /** The assistant's text, however that surface carries it. */
  text: string;
  toolCalls: ToolCall[];
  /** Checks that did not hold. Empty means it behaved. */
  failures: string[];
  ok: boolean;
  totalMs: number;
}

/** Read the answer text out of whichever surface produced it. */
export function readAnswerText(surface: PromptSurfaceId, body: unknown): string {
  if (body === null || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;

  if (surface === 'chat.completions') {
    const choices = b['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const msg = (choices[0] as Record<string, unknown>)['message'];
    if (msg === null || typeof msg !== 'object') return '';
    const content = (msg as Record<string, unknown>)['content'];
    return typeof content === 'string' ? content : '';
  }

  // Responses: prefer the convenience field, fall back to walking output[].
  if (typeof b['output_text'] === 'string') return b['output_text'];
  const out = b['output'];
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec['type'] !== 'message') continue;
    const content = rec['content'];
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c !== null && typeof c === 'object') {
        const text = (c as Record<string, unknown>)['text'];
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  return parts.join('');
}

/** Tool calls, from whichever place that surface keeps them. */
export function readPromptToolCalls(surface: PromptSurfaceId, body: unknown): ToolCall[] {
  return surface === 'responses' ? extractResponsesToolCalls(body) : extractToolCalls(body);
}

/** Evaluate one surface's answer against the case's expectation. */
export function evaluatePromptOutcome(
  surface: PromptSurfaceId,
  promptCase: PromptCase,
  exchange: Exchange,
): PromptOutcome {
  const status = exchange.response?.status ?? null;
  const body = exchange.response?.body;
  const text = readAnswerText(surface, body);
  const toolCalls = readPromptToolCalls(surface, body);
  const failures: string[] = [];

  if (exchange.transportError !== undefined) {
    failures.push(`transport: ${exchange.transportError}`);
  } else if (status !== 200) {
    failures.push(`HTTP ${status ?? '—'}, expected 200`);
  } else {
    const e = promptCase.expect;
    const lower = text.toLowerCase();

    if (e.nonEmpty === true && text.trim().length === 0 && toolCalls.length === 0) {
      failures.push('answer was empty and no tool was called');
    }
    for (const needle of e.mentions ?? []) {
      if (!lower.includes(needle.toLowerCase())) failures.push(`answer omits "${needle}"`);
    }
    for (const needle of e.absent ?? []) {
      if (lower.includes(needle.toLowerCase())) failures.push(`answer contains "${needle}"`);
    }
    if (e.jsonParses === true) {
      // Tolerate a fenced block — the check is whether JSON is recoverable, not
      // whether the model obeyed the "no code fence" instruction, which is a
      // model-behaviour question and not the gateway's fault.
      const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      try {
        JSON.parse(stripped);
      } catch {
        failures.push('answer is not parseable JSON');
      }
    }
    if (e.callsTool !== undefined && !toolCalls.some((c) => c.name === e.callsTool)) {
      const got = toolCalls.length > 0 ? toolCalls.map((c) => c.name).join(', ') : 'none';
      failures.push(`expected a call to "${e.callsTool}", got ${got}`);
    }
    if (e.noToolCalls === true && toolCalls.length > 0) {
      failures.push(`expected no tool calls, got ${toolCalls.map((c) => c.name).join(', ')}`);
    }
  }

  return {
    surface,
    exchangeId: exchange.id,
    status,
    text,
    toolCalls,
    failures,
    ok: failures.length === 0,
    totalMs: exchange.timings.totalMs,
  };
}

/** The cross-surface verdict for one prompt case. */
export interface PromptComparison {
  agrees: boolean;
  /** Why they disagree, in client-visible terms. Empty when they agree. */
  differences: string[];
}

/**
 * Compare the two surfaces.
 *
 * Deliberately NOT text equality. A model is not deterministic, so demanding
 * identical strings would report a disagreement on every run and the signal
 * would be worthless. What a client actually depends on is narrower: did a tool
 * get called, which one, and did an answer come back at all.
 */
export function comparePromptOutcomes(outcomes: readonly PromptOutcome[]): PromptComparison {
  const differences: string[] = [];
  if (outcomes.length < 2) return { agrees: true, differences };

  const [a, b] = outcomes as [PromptOutcome, PromptOutcome];

  if (a.ok !== b.ok) {
    const failed = a.ok ? b : a;
    differences.push(
      `${failed.surface} failed its checks while ${(a.ok ? a : b).surface} passed: ${failed.failures.join('; ')}`,
    );
  }

  const namesA = [...a.toolCalls.map((c) => c.name)].sort().join(',');
  const namesB = [...b.toolCalls.map((c) => c.name)].sort().join(',');
  if (namesA !== namesB) {
    differences.push(
      `different tool calls — ${a.surface}: [${namesA || 'none'}], ${b.surface}: [${namesB || 'none'}]`,
    );
  }

  const emptyA = a.text.trim().length === 0;
  const emptyB = b.text.trim().length === 0;
  if (emptyA !== emptyB) {
    differences.push(
      `one surface answered and the other did not — ${a.surface}: ${emptyA ? 'empty' : 'text'}, ${b.surface}: ${emptyB ? 'empty' : 'text'}`,
    );
  }

  return { agrees: differences.length === 0, differences };
}

/** One prompt case, run across the selected surfaces. */
export interface PromptResult {
  caseId: string;
  title: string;
  outcomes: PromptOutcome[];
  comparison: PromptComparison;
  /** The case passed everywhere AND, if required, the surfaces agree. */
  ok: boolean;
}

export function summarisePromptResult(
  promptCase: PromptCase,
  outcomes: PromptOutcome[],
): PromptResult {
  const comparison = comparePromptOutcomes(outcomes);
  const needsAgreement = promptCase.expect.agreesAcrossSurfaces === true && outcomes.length > 1;
  return {
    caseId: promptCase.id,
    title: promptCase.title,
    outcomes,
    comparison,
    ok: outcomes.every((o) => o.ok) && (!needsAgreement || comparison.agrees),
  };
}

/** Cost ceiling for a run, so the bill is visible before anything is sent. */
export function estimateRun(
  cases: readonly PromptCase[],
  surfaces: readonly PromptSurfaceId[],
): { calls: number; maxOutputTokens: number } {
  const calls = cases.length * surfaces.length;
  const maxOutputTokens = cases.reduce((sum, c) => sum + c.maxTokens * surfaces.length, 0);
  return { calls, maxOutputTokens };
}
