/**
 * MCP as a client sees it.
 *
 * The gateway brokers MCP servers on the caller's behalf: it discovers their
 * tools, decides which this key may use, and runs the tool loop itself. So
 * there are three separate questions a client can ask, and they have different
 * answers:
 *
 *  1. **What am I entitled to?** `GET /v1/mcp/servers` and `GET /v1/mcp/tools`,
 *     both filtered by the key's `mcpAccess` scope.
 *  2. **What is each tool's effective policy?** Both list endpoints carry a
 *     `policy` per tool. A tool can be advertised and still be refused.
 *  3. **What actually happened during a call?** The gateway emits
 *     `mcp_tool_call` events into the stream while it executes tools, which is
 *     the only client-visible window into work it did on your behalf.
 */

import type { StreamChunk } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * The wire values for a tool's effective policy.
 *
 * Note `ask`. The gateway's enforcement model no longer has an ask state —
 * `NEED_APPROVAL` was removed, and internally a policy is either a grant or it
 * is not — but the API still advertises `ask` as a possible value. A client
 * that branches on it is coding against a state nothing will produce, or worse,
 * one that silently behaves as something else. Worth knowing which values a
 * real gateway actually returns.
 */
export type McpPolicy = 'allow' | 'ask' | 'block' | 'unknown';

export function readPolicy(raw: unknown): McpPolicy {
  const value = str(raw).toLowerCase();
  return value === 'allow' || value === 'ask' || value === 'block' ? value : 'unknown';
}

export interface McpTool {
  name: string;
  description?: string;
  policy: McpPolicy;
  /** Present on the flat listing; absent when nested under a server. */
  server?: string;
  serverId?: string;
}

export interface McpServer {
  id: string;
  name: string;
  transport: string;
  tools: McpTool[];
}

/** `GET /v1/mcp/servers` → `{ servers: [...] }`, read defensively. */
export function readMcpServers(body: unknown): McpServer[] {
  if (!isRecord(body)) return [];
  const list = body['servers'];
  if (!Array.isArray(list)) return [];
  const out: McpServer[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const tools: McpTool[] = [];
    const rawTools = raw['tools'];
    if (Array.isArray(rawTools)) {
      for (const t of rawTools) {
        if (!isRecord(t)) continue;
        const tool: McpTool = { name: str(t['name']), policy: readPolicy(t['policy']) };
        const description = str(t['description']);
        if (description.length > 0) tool.description = description;
        tools.push(tool);
      }
    }
    out.push({
      id: str(raw['id']),
      name: str(raw['name']),
      transport: str(raw['transport']),
      tools,
    });
  }
  return out;
}

/** `GET /v1/mcp/tools` → `{ tools: [...] }`, flattened across servers. */
export function readMcpTools(body: unknown): McpTool[] {
  if (!isRecord(body)) return [];
  const list = body['tools'];
  if (!Array.isArray(list)) return [];
  const out: McpTool[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const tool: McpTool = {
      // The flat listing names the field `tool`, the nested one `name`.
      name: str(raw['tool'], str(raw['name'])),
      policy: readPolicy(raw['policy']),
    };
    const description = str(raw['description']);
    if (description.length > 0) tool.description = description;
    const server = str(raw['server']);
    if (server.length > 0) tool.server = server;
    const serverId = str(raw['server_id']);
    if (serverId.length > 0) tool.serverId = serverId;
    out.push(tool);
  }
  return out;
}

export interface PolicyTally {
  allow: number;
  ask: number;
  block: number;
  unknown: number;
  total: number;
}

export function tallyPolicies(tools: readonly McpTool[]): PolicyTally {
  const tally: PolicyTally = { allow: 0, ask: 0, block: 0, unknown: 0, total: tools.length };
  for (const t of tools) tally[t.policy]++;
  return tally;
}

// ── Stream events ────────────────────────────────────────────────────────────

/**
 * An `mcp_tool_call` frame: the gateway telling you it is running a tool for
 * you.
 *
 * This is the only client-visible account of brokered work. Without it a
 * caller sees a long pause and then an answer, with no way to know whether the
 * gateway called three tools or none, which server it reached, or how long each
 * took.
 */
export interface McpToolEvent {
  tool: string;
  server: string;
  status: 'running' | 'done' | 'error' | 'unknown';
  args?: unknown;
  result?: string;
  /** ms since the request started, from the frame that carried it. */
  t: number;
  seq: number;
}

function readStatus(raw: unknown): McpToolEvent['status'] {
  const value = str(raw);
  return value === 'running' || value === 'done' || value === 'error' ? value : 'unknown';
}

/** Recognises an `mcp_tool_call` frame. Returns undefined for anything else. */
export function readMcpToolEvent(chunk: StreamChunk): McpToolEvent | undefined {
  const parsed = chunk.parsed;
  if (!isRecord(parsed)) return undefined;
  if (parsed['type'] !== 'mcp_tool_call') return undefined;

  const event: McpToolEvent = {
    tool: str(parsed['tool']),
    server: str(parsed['server']),
    status: readStatus(parsed['status']),
    t: chunk.t,
    seq: chunk.seq,
  };
  if (parsed['args'] !== undefined) event.args = parsed['args'];
  const result = str(parsed['result']);
  if (result.length > 0) event.result = result;
  return event;
}

export interface McpCallSummary {
  tool: string;
  server: string;
  /** Time from the `running` frame to the matching `done`/`error`. */
  durationMs?: number;
  status: McpToolEvent['status'];
  args?: unknown;
  result?: string;
}

/**
 * Pairs `running` frames with their terminal frame so each brokered call gets
 * one row with a duration, rather than two events the reader has to match up.
 */
export function summariseMcpCalls(chunks: readonly StreamChunk[]): McpCallSummary[] {
  const events = chunks
    .map((c) => readMcpToolEvent(c))
    .filter((e): e is McpToolEvent => e !== undefined);

  const open = new Map<string, McpToolEvent>();
  const out: McpCallSummary[] = [];

  for (const event of events) {
    const key = `${event.server}::${event.tool}`;
    if (event.status === 'running') {
      open.set(key, event);
      continue;
    }
    const started = open.get(key);
    open.delete(key);
    const summary: McpCallSummary = {
      tool: event.tool,
      server: event.server,
      status: event.status,
    };
    if (started !== undefined) summary.durationMs = Math.round((event.t - started.t) * 100) / 100;
    if (started?.args !== undefined) summary.args = started.args;
    if (event.result !== undefined) summary.result = event.result;
    out.push(summary);
  }

  // A `running` with no terminal frame is a call the stream never accounted
  // for — worth showing rather than dropping.
  for (const started of open.values()) {
    out.push({ tool: started.tool, server: started.server, status: 'running', ...(started.args !== undefined ? { args: started.args } : {}) });
  }
  return out;
}
