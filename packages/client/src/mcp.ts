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

// ── Buffered MCP output items ────────────────────────────────────────────────
//
// Everything above this line reads the *streaming* `mcp_tool_call` frames the
// chat path emits. These read the *buffered* `output[]` items the Responses path
// returns, which are a different artifact with different field names.
//
// Missing that distinction was a real gap: `extractResponsesToolCalls` only
// matches `function_call`, so a brokered MCP call — the gateway running a tool
// on the caller's behalf — read as "no tool calls at all" on a response where a
// tool had plainly run. Measured against a live org before this was written.
//
// The two are kept apart deliberately and must never be merged into one list. A
// `function_call` is handed BACK for the client to execute; an `mcp_call` was
// already executed BY the gateway. Reporting them as one kind of thing would
// destroy the single distinction this whole tool exists to observe.

/** One `mcp_call` item: a tool the GATEWAY ran, reported after the fact. */
export interface McpBrokeredCall {
  id: string;
  /** As advertised to the client — the upstream name, not the wire name. */
  name: string;
  argumentsText: string;
  argumentsParsed?: unknown;
  /** Which server ran it. See `McpItemIssue` for why this may be unusable. */
  serverLabel: string;
  output?: string;
  error?: string;
  /** Non-standard: OpenAI's `McpCall` has no status field. Recorded, not required. */
  status?: string;
  /** True when the output carries the gateway's own truncation marker. */
  truncated: boolean;
}

const TRUNCATION_MARKER = 'truncated by the gateway';

/** Read every `mcp_call` item out of a buffered Responses body. */
export function readMcpBrokeredCalls(body: unknown): McpBrokeredCall[] {
  if (!isRecord(body)) return [];
  const output = body['output'];
  if (!Array.isArray(output)) return [];

  const out: McpBrokeredCall[] = [];
  for (const raw of output) {
    if (!isRecord(raw)) continue;
    if (raw['type'] !== 'mcp_call') continue;

    const argsText = str(raw['arguments']);
    const outputText = typeof raw['output'] === 'string' ? raw['output'] : undefined;
    const call: McpBrokeredCall = {
      id: str(raw['id']),
      name: str(raw['name']),
      argumentsText: argsText,
      serverLabel: str(raw['server_label']),
      truncated: outputText !== undefined && outputText.includes(TRUNCATION_MARKER),
    };
    if (argsText.length > 0) {
      try {
        call.argumentsParsed = JSON.parse(argsText);
      } catch {
        // Malformed arguments are the finding, not a crash.
      }
    }
    if (outputText !== undefined) call.output = outputText;
    const error = raw['error'];
    if (typeof error === 'string' && error.length > 0) call.error = error;
    const status = str(raw['status']);
    if (status.length > 0) call.status = status;
    out.push(call);
  }
  return out;
}

/** One tool as named inside an `mcp_list_tools` item. */
export interface McpOfferedTool {
  name: string;
  description?: string;
  /** Present in this gateway's output; not part of OpenAI's `Tool` type. */
  serverLabel?: string;
  /** OpenAI declares `input_schema` REQUIRED. Absent here more often than not. */
  hasInputSchema: boolean;
}

/** One `mcp_list_tools` item: what the model was actually offered. */
export interface McpListing {
  id: string;
  /**
   * Raw value. May be several server names joined with commas rather than one
   * server — see `checkMcpItems`.
   */
  serverLabel: string;
  /** `serverLabel` split on commas, the only way to recover the names. */
  serverLabels: string[];
  tools: McpOfferedTool[];
  error?: string;
  status?: string;
}

/** Read every `mcp_list_tools` item out of a buffered Responses body. */
export function readMcpListings(body: unknown): McpListing[] {
  if (!isRecord(body)) return [];
  const output = body['output'];
  if (!Array.isArray(output)) return [];

  const out: McpListing[] = [];
  for (const raw of output) {
    if (!isRecord(raw)) continue;
    if (raw['type'] !== 'mcp_list_tools') continue;

    const label = str(raw['server_label']);
    const tools: McpOfferedTool[] = [];
    const rawTools = raw['tools'];
    if (Array.isArray(rawTools)) {
      for (const t of rawTools) {
        if (!isRecord(t)) continue;
        const tool: McpOfferedTool = {
          name: str(t['name'], str(t['tool'])),
          // Both spellings, because the two MCP endpoints disagree already.
          hasInputSchema: t['input_schema'] !== undefined || t['inputSchema'] !== undefined,
        };
        const description = str(t['description']);
        if (description.length > 0) tool.description = description;
        const serverLabel = str(t['server_label']);
        if (serverLabel.length > 0) tool.serverLabel = serverLabel;
        tools.push(tool);
      }
    }

    const listing: McpListing = {
      id: str(raw['id']),
      serverLabel: label,
      serverLabels: label
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      tools,
    };
    const error = raw['error'];
    if (typeof error === 'string' && error.length > 0) listing.error = error;
    const status = str(raw['status']);
    if (status.length > 0) listing.status = status;
    out.push(listing);
  }
  return out;
}

/** A divergence from the OpenAI item contract, stated in client terms. */
export interface McpItemIssue {
  kind:
    | 'server-label-is-a-list'
    | 'missing-input-schema'
    | 'nonstandard-status'
    | 'output-truncated'
    | 'listing-absent-though-tool-ran';
  detail: string;
}

/**
 * Check the buffered MCP items against OpenAI's published item contract, read
 * from the vendored `openai` SDK types rather than from memory.
 *
 * Reported, never thrown: the job is to make a divergence visible to whoever is
 * reading the response, not to decide it is fatal.
 */
export function checkMcpItems(body: unknown): McpItemIssue[] {
  const issues: McpItemIssue[] = [];
  const listings = readMcpListings(body);
  const calls = readMcpBrokeredCalls(body);

  for (const listing of listings) {
    // OpenAI's `server_label` names ONE server, and it emits one item per
    // server. A comma-joined value matches no server a client can look up.
    if (listing.serverLabels.length > 1) {
      issues.push({
        kind: 'server-label-is-a-list',
        detail:
          `server_label carries ${String(listing.serverLabels.length)} server names joined by ` +
          `commas ("${listing.serverLabel}"). OpenAI emits one mcp_list_tools item per server ` +
          `with a single-server label, so a client resolving this value finds nothing.`,
      });
    }

    const noSchema = listing.tools.filter((t) => !t.hasInputSchema).map((t) => t.name);
    if (noSchema.length > 0) {
      issues.push({
        kind: 'missing-input-schema',
        detail:
          `${String(noSchema.length)} of ${String(listing.tools.length)} offered tools carry no ` +
          `input_schema, which OpenAI declares required: ${noSchema.slice(0, 4).join(', ')}` +
          `${noSchema.length > 4 ? ' and more' : ''}. The schemas do exist on /v1/mcp/tools, so a ` +
          `client rendering this listing cannot show argument shapes it could have been given.`,
      });
    }

    if (listing.status !== undefined) {
      issues.push({
        kind: 'nonstandard-status',
        detail: `mcp_list_tools carries status="${listing.status}"; OpenAI's item has no status field.`,
      });
    }
  }

  for (const call of calls) {
    if (call.truncated) {
      issues.push({
        kind: 'output-truncated',
        detail:
          `mcp_call "${call.name}" output was truncated by the gateway at ` +
          `${String(call.output?.length ?? 0)} characters. The MODEL saw the truncated result, so ` +
          `the answer is built on less than the tool actually returned.`,
      });
    }
    if (call.status !== undefined) {
      issues.push({
        kind: 'nonstandard-status',
        detail: `mcp_call carries status="${call.status}"; OpenAI's item has no status field.`,
      });
    }
  }

  // Measured on a live org: a request where no tool ran carried no listing at
  // all, though the model demonstrably had the tools. So a client cannot tell
  // "nothing was offered" from "something was offered and not used".
  if (calls.length > 0 && listings.length === 0) {
    issues.push({
      kind: 'listing-absent-though-tool-ran',
      detail:
        'A tool ran but no mcp_list_tools item was emitted, so there is no record of what was offered.',
    });
  }

  return issues;
}

/** Offered-tool names across every listing, deduplicated and sorted. */
export function offeredToolNames(body: unknown): string[] {
  const names = new Set<string>();
  for (const listing of readMcpListings(body)) {
    for (const tool of listing.tools) if (tool.name.length > 0) names.add(tool.name);
  }
  return [...names].sort();
}
