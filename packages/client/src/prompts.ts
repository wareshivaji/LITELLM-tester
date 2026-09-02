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
import {
  checkMcpItems,
  offeredToolNames,
  readMcpBrokeredCalls,
  type McpBrokeredCall,
  type McpItemIssue,
} from './mcp.js';
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
  /**
   * The GATEWAY must have run an MCP tool with this name.
   *
   * Separate from `callsTool` on purpose: that one means the model asked the
   * client to run something, this one means the gateway already ran it. A test
   * that cannot tell those apart is not testing brokering.
   */
  brokersTool?: string;
  /** These tools must appear in the offered list (`mcp_list_tools`). */
  offersTool?: string | string[];
  /**
   * These tools must NOT be offered — the only way a BLOCK policy is proved.
   *
   * Not by asking the model and reading the prose: a blocked tool is withheld
   * entirely, so the model answers around the gap with an allowed tool or from
   * its own knowledge, and a plausible answer is indistinguishable from a
   * working block. The offered list is the evidence.
   */
  withholdsTool?: string | string[];
  /**
   * The call is EXPECTED to be refused, with any of these statuses.
   *
   * Without this every content check runs against a 200, so a legitimate
   * refusal reads as a failure. Added after `mcp-declared-block-stripped`
   * returned 403 where the walkthrough documents 400 — the refusal was the
   * right OUTCOME and expecting a 200 was simply wrong.
   */
  refusedWith?: number[];
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
  /**
   * How MCP reaches this request.
   *
   *  - `key-driven` — send NO tool block and let the gateway broker from the
   *    key's own entitlement. This is what TokenShield actually does, and it is
   *    the mode that works against a real org: the gateway strips any
   *    `type:"mcp"` block a client sends and honours it only as a filter that
   *    can narrow what the key already permits. Verified against a live org on
   *    2026-09-01 — seven responses all carried `mcp_list_tools` and `mcp_call`
   *    with nothing declared by the caller.
   *  - `declared` — send a `type:"mcp"` block, which is the LiteLLM and OpenAI
   *    way. Against TokenShield this tests the STRIP, not the brokering: a
   *    block naming a server the key cannot reach is a 400 rather than a silent
   *    no-op.
   *  - omitted — no MCP at all.
   */
  mcpMode?: 'key-driven' | 'declared';
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
  // ── MCP against a real org ────────────────────────────────────────────────
  // These need a key with MCP entitlement — no tool block is sent, because on
  // TokenShield the KEY is the trigger. The tool names below are from the org
  // used for verification on 2026-09-01; change them for another org.
  {
    id: 'mcp-key-driven',
    title: 'The gateway brokers from the key, with nothing declared',
    why: 'Sends no MCP tool block at all. If a tool still runs, brokering is driven entirely by the key\'s entitlement — which is TokenShield\'s model and the opposite of LiteLLM, where the caller must opt in per request. Also the cheapest proof that mcp_list_tools and mcp_call reach the client.',
    prompt: 'Search Hugging Face for models matching "distilbert". List just the top 3 names.',
    expect: {
      nonEmpty: true,
      brokersTool: 'hub_repo_search',
      offersTool: ['hub_repo_search', 'microsoft_docs_search'],
    },
    maxTokens: 160,
    mcpMode: 'key-driven',
    tools: 'none',
  },
  {
    id: 'mcp-block-is-provable',
    title: 'A blocked tool is absent from the offered list',
    why: 'The case that cannot be tested by reading the answer. A blocked tool is WITHHELD, so the model answers with an allowed tool or from memory and the prose looks fine either way — a plausible answer is indistinguishable from a working block. This asserts on the offered list instead, which is the only actual evidence. Both blocked tools are checked at once, and an absent listing reports "cannot tell" rather than passing.',
    prompt: 'Fetch the full page content of the Microsoft Learn article on Durable Functions, and list the files in the HuggingFace repo bert-base-uncased.',
    expect: {
      nonEmpty: true,
      withholdsTool: ['hf_fs', 'microsoft_docs_fetch'],
      offersTool: ['microsoft_docs_search', 'hub_repo_search'],
    },
    maxTokens: 200,
    mcpMode: 'key-driven',
    tools: 'none',
  },
  {
    id: 'mcp-out-of-scope-server',
    title: 'A server the key was never granted is not reachable',
    why: 'Context7 is not in this key\'s serverIds, so none of its tools should appear. Distinct from a BLOCK: a blocked tool stays in the routing index and refuses as policy_block, while a tool from an ungranted server was never indexed and refuses as unknown_tool. Getting those two the wrong way round sends an engineer looking in entirely the wrong place.',
    prompt: 'Use Context7 to look up React useEffect documentation.',
    expect: {
      nonEmpty: true,
      withholdsTool: ['get_library_docs', 'resolve_library_id'],
    },
    maxTokens: 160,
    mcpMode: 'key-driven',
    tools: 'none',
  },
  {
    id: 'mcp-cross-server',
    title: 'Two servers in one request',
    why: 'One prompt needing Hugging Face and Cloudflare. Proves the aggregated list spans servers and that a call routes back to the right one — the reason wire names are namespaced at all. Watch server_label on each mcp_call: if both come back the same, attribution is broken.',
    prompt: 'Search Hugging Face for "distilbert" models, then search the Cloudflare docs for "Workers KV write limits". One sentence on each.',
    expect: { nonEmpty: true, offersTool: ['hub_repo_search', 'search_cloudflare_documentation'] },
    maxTokens: 240,
    mcpMode: 'key-driven',
    tools: 'none',
  },
  {
    id: 'mcp-declared-block-stripped',
    title: 'A declared type:"mcp" block naming an unreachable server',
    why: 'The LiteLLM and OpenAI way of asking for MCP, pointed at the lab\'s own server, which is NOT a registered org server. TokenShield strips the block unconditionally and then honours it only as a filter that can narrow what the key permits — so naming something unreachable should be a 400 rather than a silent no-op. A 200 here would mean the block was quietly ignored, which is the worse outcome: a client believes it scoped the request and it did not.',
    prompt: 'Use the lab tool to check the weather in Paris.',
    // MEASURED 2026-09-02: 403 on both surfaces, 267ms on Responses — fast
    // enough to be pre-provider. The walkthrough documents 400 for this case,
    // so code and doc differ; either way it is REFUSED rather than silently
    // ignored, which is the outcome that matters. A 200 would mean the block
    // was dropped while the client believes it scoped the request.
    expect: { refusedWith: [400, 403] },
    maxTokens: 120,
    mcpMode: 'declared',
    tools: 'none',
  },
  {
    id: 'mcp-and-client-tools',
    title: 'A client tool alongside the gateway\'s own',
    why: 'The mixed case, prod-confirmed to deadlock. The gateway must broker its own tool and hand the client one back; swallowing either is a hang or a wrong answer. No MCP block is declared — the entitlement supplies the gateway side.',
    prompt: 'What is the weather in Paris? Also search Hugging Face for "distilbert".',
    // MEASURED 2026-09-02, and the expectation was far too weak before — this
    // case PASSED on `nonEmpty` while revealing the finding. The client got
    // back two tool calls: its own `get_weather`, and
    // `huggingface__hub_repo_search`, which it never declared and cannot run.
    // So the gateway hands its own brokered tool back to the caller under the
    // WIRE name. Handing the whole turn back is documented and deliberate;
    // handing back a call for a tool the client does not have leaves it with
    // nothing sensible to do.
    expect: { nonEmpty: true, callsTool: 'get_weather' },
    maxTokens: 200,
    mcpMode: 'key-driven',
    tools: 'weather',
  },
];

/** Options for building a request body from a case. */
export interface BuildOptions {
  model: string;
  /**
   * The `server_url` for a `declared` case.
   *
   * Defaults to the lab's own MCP server. Note that against TokenShield the
   * lab's server is not a registered org server, so a declared block naming it
   * matches nothing reachable — which is the 400 that case is checking for, not
   * a misconfiguration.
   */
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
  // `key-driven` deliberately declares NOTHING: the entitlement on the key is
  // the trigger, and adding a block here would test the strip instead.
  if (promptCase.mcpMode === 'declared' && opts.mcpServerUrl !== undefined) {
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
  /** Calls handed BACK for the client to run. */
  toolCalls: ToolCall[];
  /** Calls the GATEWAY ran itself. Never merged with the above. */
  brokeredCalls: McpBrokeredCall[];
  /** What the model was offered, per `mcp_list_tools`. */
  offeredTools: string[];
  /** Divergences from OpenAI's MCP item contract. Reported, not failed on. */
  mcpIssues: McpItemIssue[];
  /** Checks that did not hold. Empty means it behaved. */
  failures: string[];
  ok: boolean;
  totalMs: number;
}

function asList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
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
  // Brokered calls and the offered listing only exist on Responses; on chat
  // these come back empty, which is itself the honest answer — the chat path
  // emits no transparency items at all.
  const brokeredCalls = readMcpBrokeredCalls(body);
  const offeredTools = offeredToolNames(body);
  const mcpIssues = checkMcpItems(body);
  const failures: string[] = [];

  const expectRefusal = promptCase.expect.refusedWith;
  if (exchange.transportError !== undefined) {
    failures.push(`transport: ${exchange.transportError}`);
  } else if (expectRefusal !== undefined) {
    // A case expecting a refusal is checked on the STATUS and nothing else.
    // Running content checks against a refusal body reports the same defect
    // several times over and buries the one that matters.
    if (status === null || !expectRefusal.includes(status)) {
      failures.push(
        `expected a refusal (${expectRefusal.join(' or ')}), got HTTP ${status ?? '—'}` +
          (status === 200
            ? ' — a 200 means the request was accepted, which is the worse outcome'
            : ''),
      );
    }
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
    if (e.brokersTool !== undefined && !brokeredCalls.some((c) => c.name === e.brokersTool)) {
      const got = brokeredCalls.length > 0 ? brokeredCalls.map((c) => c.name).join(', ') : 'none';
      failures.push(`expected the gateway to run "${e.brokersTool}", it ran ${got}`);
    }
    const wantOffered = e.offersTool === undefined ? [] : asList(e.offersTool);
    const notOffered = wantOffered.filter((t) => !offeredTools.includes(t));
    if (notOffered.length > 0) {
      failures.push(
        offeredTools.length === 0
          ? `expected ${notOffered.map((t) => `"${t}"`).join(', ')} to be offered, but no mcp_list_tools item was emitted at all`
          : `expected ${notOffered.map((t) => `"${t}"`).join(', ')} to be offered; offered: ${offeredTools.join(', ')}`,
      );
    }
    // A withheld tool must be absent from a listing that EXISTS. With no
    // listing there is nothing to be absent from, and calling that a pass would
    // report "blocked" on any response that simply never listed anything.
    if (e.withholdsTool !== undefined) {
      const wantWithheld = asList(e.withholdsTool);
      if (offeredTools.length === 0) {
        failures.push(
          `cannot tell whether ${wantWithheld.map((t) => `"${t}"`).join(', ')} ` +
            `${wantWithheld.length === 1 ? 'was' : 'were'} withheld: no mcp_list_tools item was emitted`,
        );
      } else {
        const leaked = wantWithheld.filter((t) => offeredTools.includes(t));
        if (leaked.length > 0) {
          failures.push(
            `expected ${leaked.map((t) => `"${t}"`).join(', ')} to be withheld, but ` +
              `${leaked.length === 1 ? 'it was' : 'they were'} offered`,
          );
        }
      }
    }
  }

  return {
    surface,
    exchangeId: exchange.id,
    status,
    text,
    toolCalls,
    brokeredCalls,
    offeredTools,
    mcpIssues,
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

  const namesA = [...(a.toolCalls ?? []).map((c) => c.name)].sort().join(',');
  const namesB = [...(b.toolCalls ?? []).map((c) => c.name)].sort().join(',');
  if (namesA !== namesB) {
    differences.push(
      `different tool calls — ${a.surface}: [${namesA || 'none'}], ${b.surface}: [${namesB || 'none'}]`,
    );
  }

  // Brokered work compared separately. A surface that runs a tool and one that
  // does not have behaved differently even when both end in the same prose,
  // and on today's gateway this is expected rather than surprising: chat emits
  // no transparency items, so it reports nothing brokered by construction.
  // `?? []` rather than trusting the type: these outcomes arrive over SSE as
  // plain JSON, so an older or partial payload can be missing the field
  // entirely. Crashing the comparison would lose every result in the run.
  const brokeredA = [...(a.brokeredCalls ?? []).map((c) => c.name)].sort().join(',');
  const brokeredB = [...(b.brokeredCalls ?? []).map((c) => c.name)].sort().join(',');
  if (brokeredA !== brokeredB) {
    differences.push(
      `different brokered tools — ${a.surface}: [${brokeredA || 'none'}], ` +
        `${b.surface}: [${brokeredB || 'none'}]. Note chat emits no mcp_call items at all, so a ` +
        `difference here may mean "not reported" rather than "not run".`,
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
