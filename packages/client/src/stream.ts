/**
 * Reading a recorded stream.
 *
 * A streaming response is not one answer, it is a shape over time — so the
 * questions worth asking are about the shape: when did the first token arrive,
 * where were the stalls, did every frame carry the fields an SDK expects, and
 * did the stream terminate properly or just stop.
 *
 * The anomaly checks are the point. A stream can deliver perfectly good text
 * while every frame is missing `id`, reporting `created: 0`, or carrying a null
 * `delta` — none of which shows up if you only look at the assembled output,
 * and all of which a strict client will trip over.
 */

import { summariseMcpCalls } from './mcp.js';
import type { McpCallSummary } from './mcp.js';
import { readUsage } from './surfaces.js';
import type { UsageSummary } from './surfaces.js';
import type { StreamChunk } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Inter-frame gap, rounded. Exported so the timeline shows the same numbers. */
export function gapMs(current: number, previous: number): number {
  return round2(current - previous);
}

function firstChoice(parsed: unknown): Record<string, unknown> | undefined {
  if (!isRecord(parsed)) return undefined;
  const choices = parsed['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  return isRecord(first) ? first : undefined;
}

/** The incremental text this frame carries, if any. Shape differs per surface. */
export function readStreamDelta(surfaceId: string, chunk: StreamChunk): string | undefined {
  const parsed = chunk.parsed;
  if (parsed === undefined) return undefined;

  if (surfaceId === 'chat.completions') {
    const choice = firstChoice(parsed);
    if (choice === undefined) return undefined;
    const delta = choice['delta'];
    if (!isRecord(delta)) return undefined;
    const content = delta['content'];
    return typeof content === 'string' ? content : undefined;
  }

  if (surfaceId === 'completions') {
    const choice = firstChoice(parsed);
    const text = choice?.['text'];
    return typeof text === 'string' ? text : undefined;
  }

  if (surfaceId === 'messages') {
    // Anthropic: event-per-frame. Text arrives on content_block_delta.
    if (!isRecord(parsed)) return undefined;
    if (parsed['type'] !== 'content_block_delta') return undefined;
    const delta = parsed['delta'];
    if (!isRecord(delta)) return undefined;
    const text = delta['text'];
    return typeof text === 'string' ? text : undefined;
  }

  if (surfaceId === 'responses') {
    if (!isRecord(parsed)) return undefined;
    const type = parsed['type'];
    if (type !== 'response.output_text.delta') return undefined;
    const delta = parsed['delta'];
    return typeof delta === 'string' ? delta : undefined;
  }

  return undefined;
}

export interface StreamAnomaly {
  /** -1 for stream-level findings that belong to no single frame. */
  seq: number;
  issue: string;
}

export interface StreamAnalysis {
  text: string;
  /** Every frame, including comments and the [DONE] sentinel. */
  chunkCount: number;
  /** Frames that carried parseable data. */
  dataChunks: number;
  /** Frames that carried text. */
  textChunks: number;
  firstChunkMs?: number;
  firstTextMs?: number;
  lastChunkMs?: number;
  maxGapMs: number;
  meanGapMs: number;
  finishReason?: string;
  usage?: UsageSummary;
  sawDone: boolean;
  anomalies: StreamAnomaly[];
  /**
   * Tools the gateway ran for you mid-stream, paired into one row each.
   *
   * Empty for a stream with no MCP involvement. When it is not empty it is the
   * only client-visible account of work the gateway did on your behalf — a
   * caller otherwise sees a long pause and then an answer.
   */
  mcpCalls: McpCallSummary[];
}

/** Per-frame conformance checks for the OpenAI chat stream shape. */
function checkChatFrame(chunk: StreamChunk, anomalies: StreamAnomaly[]): void {
  const parsed = chunk.parsed;
  if (!isRecord(parsed)) return;

  if (parsed['id'] === '') {
    anomalies.push({ seq: chunk.seq, issue: 'empty `id` — OpenAI sends a stable chunk id' });
  }
  if (parsed['created'] === 0) {
    anomalies.push({ seq: chunk.seq, issue: '`created: 0` — not a real timestamp' });
  }

  const choice = firstChoice(parsed);
  if (choice === undefined) return;

  if (choice['delta'] === null) {
    anomalies.push({ seq: chunk.seq, issue: '`delta: null` — SDKs expect an object' });
  }

  const delta = choice['delta'];
  if (isRecord(delta)) {
    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        if (isRecord(call) && call['index'] === undefined) {
          anomalies.push({
            seq: chunk.seq,
            issue: 'tool call without `index` — SDKs cannot assemble split arguments',
          });
          break;
        }
      }
    }
  }
}

export function analyseStream(
  surfaceId: string,
  chunks: readonly StreamChunk[],
): StreamAnalysis {
  const anomalies: StreamAnomaly[] = [];
  const parts: string[] = [];
  const arrivals: number[] = [];

  let dataChunks = 0;
  let textChunks = 0;
  let firstTextMs: number | undefined;
  let finishReason: string | undefined;
  let usage: UsageSummary | undefined;
  let sawDone = false;

  for (const chunk of chunks) {
    if (chunk.done === true) sawDone = true;
    if (chunk.incomplete === true) {
      anomalies.push({ seq: chunk.seq, issue: 'stream cut mid-frame — no terminating blank line' });
    }
    if (chunk.comment === true) continue;

    arrivals.push(chunk.t);

    if (chunk.parsed !== undefined) {
      dataChunks++;
      if (surfaceId === 'chat.completions') checkChatFrame(chunk, anomalies);

      const choice = firstChoice(chunk.parsed);
      const reason = choice?.['finish_reason'];
      if (typeof reason === 'string' && reason.length > 0) finishReason = reason;
      if (isRecord(chunk.parsed)) {
        const stop = chunk.parsed['stop_reason'];
        if (typeof stop === 'string' && stop.length > 0) finishReason = stop;
      }

      const chunkUsage = readUsage(chunk.parsed);
      if (chunkUsage !== undefined) usage = chunkUsage;
    } else if (chunk.done !== true && chunk.raw.length > 0) {
      anomalies.push({ seq: chunk.seq, issue: `frame payload is not JSON: ${chunk.raw.slice(0, 60)}` });
    }

    const delta = readStreamDelta(surfaceId, chunk);
    if (delta !== undefined && delta.length > 0) {
      parts.push(delta);
      textChunks++;
      if (firstTextMs === undefined) firstTextMs = chunk.t;
    }
  }

  // Stream-level findings.
  if (chunks.length > 0 && !sawDone && surfaceId !== 'messages' && surfaceId !== 'responses') {
    anomalies.push({ seq: -1, issue: 'stream ended without a `[DONE]` sentinel' });
  }
  if (chunks.length > 0 && finishReason === undefined) {
    anomalies.push({ seq: -1, issue: 'no finish/stop reason anywhere in the stream' });
  }
  if (chunks.length > 0 && textChunks === 0) {
    anomalies.push({ seq: -1, issue: 'no frame carried any text for this surface' });
  }

  // Round after subtracting: the arrival times are already rounded, and the
  // difference of two 2-decimal floats is not one (162.95000000000005).
  const gaps: number[] = [];
  for (let i = 1; i < arrivals.length; i++) {
    gaps.push(round2((arrivals[i] ?? 0) - (arrivals[i - 1] ?? 0)));
  }

  const analysis: StreamAnalysis = {
    text: parts.join(''),
    chunkCount: chunks.length,
    dataChunks,
    textChunks,
    maxGapMs: gaps.length > 0 ? Math.max(...gaps) : 0,
    meanGapMs:
      gaps.length > 0 ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 100) / 100 : 0,
    sawDone,
    anomalies,
    mcpCalls: summariseMcpCalls(chunks),
  };

  const first = arrivals[0];
  const last = arrivals[arrivals.length - 1];
  if (first !== undefined) analysis.firstChunkMs = first;
  if (last !== undefined) analysis.lastChunkMs = last;
  if (firstTextMs !== undefined) analysis.firstTextMs = firstTextMs;
  if (finishReason !== undefined) analysis.finishReason = finishReason;
  if (usage !== undefined) analysis.usage = usage;

  return analysis;
}
