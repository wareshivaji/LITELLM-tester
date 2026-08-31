/**
 * Client-declared tools, and the round trip they imply.
 *
 * A tool call is not one request. The client offers `tools[]`, the model
 * answers with a call instead of prose, the client executes it and sends the
 * result back, and only then does an answer arrive. Two or three HTTP requests
 * to produce one reply — so the interesting failures are not in any single
 * response but in whether the conversation can be assembled at all.
 *
 * What this module is hunting:
 *
 *  - **Does the call come back in a usable shape?** An id to correlate the
 *    result with, a name, and `arguments` that parse as JSON. Any of those
 *    missing and the loop cannot continue.
 *  - **Is a client tool actually reachable?** An org with MCP servers enabled
 *    runs its own tool loop, and a tool the gateway does not recognise may be
 *    answered on the model's behalf rather than returned to the client — which
 *    would make client-declared tools silently unusable for that org.
 *  - **Does `tool_choice` restrict?** Naming a tool is supposed to force it.
 */

import type { Exchange } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool call, normalised across the chat and Responses shapes. */
export interface ToolCall {
  /** Correlation id. Empty when the gateway omitted one — itself a finding. */
  id: string;
  name: string;
  /** Raw argument text, exactly as sent. */
  argumentsText: string;
  /** Parsed, when it parses. Absent means malformed JSON arguments. */
  argumentsParsed?: unknown;
  /** Position in a parallel batch, when the response carried one. */
  index?: number;
}

export interface ToolPreset {
  id: string;
  label: string;
  /** Why this one is useful to offer. */
  why: string;
  /** OpenAI chat-shaped tool definition. */
  definition: unknown;
  /** A canned local implementation, so the loop can complete without side effects. */
  run: (args: unknown) => unknown;
}

/**
 * Two deliberately trivial tools. They exist to make the model call something,
 * not to do work — a real implementation would add failure modes that muddy
 * what is being measured. Both are pure and instant.
 */
export const TOOL_PRESETS: readonly ToolPreset[] = [
  {
    id: 'get_weather',
    label: 'get_weather',
    why: 'The canonical single-tool case. Every SDK example uses something like it.',
    definition: {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current temperature for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
    run: (args) => {
      const city = isRecord(args) && typeof args['city'] === 'string' ? args['city'] : 'unknown';
      return { city, temperature_c: 21, conditions: 'clear' };
    },
  },
  {
    id: 'get_time',
    label: 'get_time',
    why: 'A second tool, so one turn can call two — which is where parallel tool calls and the missing `index` field show up.',
    definition: {
      type: 'function',
      function: {
        name: 'get_time',
        description: 'Get the current local time in a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
    run: (args) => {
      const city = isRecord(args) && typeof args['city'] === 'string' ? args['city'] : 'unknown';
      return { city, local_time: '14:30' };
    },
  },
];

export function toolPresetById(id: string): ToolPreset | undefined {
  return TOOL_PRESETS.find((t) => t.id === id);
}

/** Reads tool calls out of a chat completion response. */
export function extractToolCalls(body: unknown): ToolCall[] {
  if (!isRecord(body)) return [];
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const first = choices[0];
  if (!isRecord(first)) return [];
  const message = first['message'];
  if (!isRecord(message)) return [];
  const calls = message['tool_calls'];
  if (!Array.isArray(calls)) return [];

  const out: ToolCall[] = [];
  for (const raw of calls) {
    if (!isRecord(raw)) continue;
    const fn = raw['function'];
    const name = isRecord(fn) && typeof fn['name'] === 'string' ? fn['name'] : '';
    const argsText = isRecord(fn) && typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
    const call: ToolCall = {
      id: typeof raw['id'] === 'string' ? raw['id'] : '',
      name,
      argumentsText: argsText,
    };
    if (typeof raw['index'] === 'number') call.index = raw['index'];
    try {
      if (argsText.length > 0) call.argumentsParsed = JSON.parse(argsText);
    } catch {
      // Left absent — malformed arguments are a finding, not a crash.
    }
    out.push(call);
  }
  return out;
}

export interface ToolCallIssue {
  call: string;
  issue: string;
}

/** Conformance checks on the calls a turn produced. */
export function checkToolCalls(calls: readonly ToolCall[]): ToolCallIssue[] {
  const issues: ToolCallIssue[] = [];
  for (const call of calls) {
    const label = call.name.length > 0 ? call.name : '(unnamed)';
    if (call.id.length === 0) {
      issues.push({ call: label, issue: 'no `id` — the result cannot be correlated back' });
    }
    if (call.name.length === 0) {
      issues.push({ call: label, issue: 'no function name' });
    }
    if (call.argumentsText.length > 0 && call.argumentsParsed === undefined) {
      issues.push({ call: label, issue: `\`arguments\` is not valid JSON: ${call.argumentsText.slice(0, 60)}` });
    }
  }
  // No `index` check here on purpose. OpenAI's non-streaming `tool_calls[]`
  // items carry `id`, `type` and `function` and nothing else — `index` exists
  // only on streaming deltas, where it is what lets a client reassemble
  // arguments split across frames. Flagging its absence in a buffered response
  // reported a conformance failure against a field the spec never promised
  // there; that check lives in stream.ts, where it is real.
  return issues;
}

/**
 * Detects the swallow: the model was offered client tools, answered with prose
 * instead of a call, and that prose looks like the gateway's own "unknown tool"
 * reply fed back to the model rather than returned to us.
 *
 * The gateway's MCP loop answers any tool absent from its index with
 * `error: unknown tool <name>` and continues the turn itself. For an org with
 * MCP servers enabled, a client's own `tools[]` are exactly the tools absent
 * from that index — so the client never sees its call.
 */
export function looksSwallowed(text: string | undefined, offered: readonly string[]): boolean {
  if (text === undefined || text.length === 0) return false;
  const lower = text.toLowerCase();
  if (lower.includes('unknown tool')) return true;
  return offered.some((name) => lower.includes(`unknown tool ${name.toLowerCase()}`));
}

/** One step of a tool conversation, for the timeline. */
export interface ToolTurn {
  index: number;
  /** What this turn was: the opening request, or a follow-up carrying results. */
  kind: 'request' | 'tool-results';
  exchangeId: string;
  status: number | null;
  verdictKind: string;
  finishReason?: string;
  toolCalls: ToolCall[];
  issues: ToolCallIssue[];
  /** Assistant prose, when the turn produced any. */
  text?: string;
  totalMs: number;
}

export function summariseTurn(
  index: number,
  kind: ToolTurn['kind'],
  exchange: Exchange,
  text: string | undefined,
): ToolTurn {
  const calls = extractToolCalls(exchange.response?.body);
  const body = exchange.response?.body;
  let finishReason: string | undefined;
  if (isRecord(body)) {
    const choices = body['choices'];
    if (Array.isArray(choices) && isRecord(choices[0])) {
      const reason = (choices[0] as Record<string, unknown>)['finish_reason'];
      if (typeof reason === 'string') finishReason = reason;
    }
  }
  const turn: ToolTurn = {
    index,
    kind,
    exchangeId: exchange.id,
    status: exchange.response?.status ?? null,
    verdictKind: exchange.verdict.kind,
    toolCalls: calls,
    issues: checkToolCalls(calls),
    totalMs: exchange.timings.totalMs,
  };
  if (finishReason !== undefined) turn.finishReason = finishReason;
  if (text !== undefined && text.length > 0) turn.text = text;
  return turn;
}
