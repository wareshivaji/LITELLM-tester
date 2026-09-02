/**
 * The inference surfaces, described once.
 *
 * The console's surface tabs, the default request bodies, the response readers
 * and (later) the scenario runner all read this table, so there is exactly one
 * place that knows where `/v1/responses` lives and what a minimal valid call
 * to it looks like.
 *
 * Deliberately NOT typed request models. A typed SDK would refuse to send
 * `stop` as a string or `content` as an array — which are precisely the calls
 * that expose gateway bugs. Bodies are `unknown` and pass through untouched;
 * the gateway's opinion of them is the result we came for.
 */

export type SurfaceFamily = 'openai' | 'anthropic' | 'utility';

export interface SurfaceSpec {
  id: string;
  label: string;
  path: string;
  method: 'GET' | 'POST';
  family: SurfaceFamily;
  /** Whether the request body carries a `model`. */
  needsModel: boolean;
  /** One line on what this endpoint is for, shown under the tab. */
  docs: string;
  /** A minimal body that should succeed, given a model and a prompt. */
  sample: (model: string, prompt: string) => unknown;
}

const chatSample = (model: string, prompt: string): unknown => ({
  model,
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 128,
});

/**
 * The surfaces under test.
 *
 * Narrowed 2026-09-02 to chat completions, responses and the MCP endpoints.
 * The Anthropic surface, text completions, embeddings and moderations were
 * removed: the gateway is not being held to those, so testing them produced
 * findings nobody was going to act on.
 *
 * One thing was genuinely lost with `moderations`: it was the only endpoint
 * that returned the FLAT `{"error":"string"}` envelope, which is the shape no
 * OpenAI SDK can parse. The classifier still recognises that envelope — it also
 * appears on guardrail blocks on chat completions, which IS in scope — so the
 * detection is kept and only the endpoint is gone. See `classify.ts`.
 */
export const SURFACES: readonly SurfaceSpec[] = [
  {
    id: 'chat.completions',
    label: 'Chat Completions',
    path: '/v1/chat/completions',
    method: 'POST',
    family: 'openai',
    needsModel: true,
    docs: 'The call almost every customer makes. OpenAI SDK default.',
    sample: chatSample,
  },
  {
    id: 'responses',
    label: 'Responses',
    path: '/v1/responses',
    method: 'POST',
    family: 'openai',
    needsModel: true,
    docs: "OpenAI's newer surface. Different request and response shape from chat.",
    sample: (model, prompt) => ({ model, input: prompt, max_output_tokens: 128 }),
  },
  {
    id: 'mcp.servers',
    label: 'MCP servers',
    path: '/v1/mcp/servers',
    method: 'GET',
    family: 'utility',
    needsModel: false,
    docs: "The MCP servers this key is entitled to, with each tool's effective policy.",
    sample: () => ({}),
  },
  {
    id: 'mcp.aggregate',
    label: 'MCP aggregate',
    path: '/v1/mcp',
    method: 'POST',
    family: 'utility',
    needsModel: false,
    docs: 'Streamable HTTP, JSON-RPC. What Cursor, Claude Desktop and the MCP SDKs speak.',
    sample: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  },
];

/**
 * Endpoints the lab CALLS but does not test.
 *
 * The scope is chat completions and responses (plus the MCP surface). The token
 * counter is not in that scope and is not a tab — but it is kept because it is
 * the only way to probe the `allowedModels` gate for FREE: it resolves and
 * authorises a model without generating a single token. Deleting it to tidy the
 * surface list would have made a working free test cost money, which is a bad
 * trade for a shorter list.
 *
 * `surfaceById` resolves these too, so callers do not care which list a spec
 * came from. They simply never appear in the UI.
 */
export const INSTRUMENTS: readonly SurfaceSpec[] = [
  {
    id: 'tokens.count',
    label: 'Count Tokens',
    path: '/v1/tokens/count',
    method: 'POST',
    family: 'utility',
    needsModel: true,
    docs: 'Gateway-specific counter. Request shape is undocumented — probing it is the point.',
    sample: chatSample,
  }
];

export function surfaceById(id: string): SurfaceSpec | undefined {
  return SURFACES.find((s) => s.id === id) ?? INSTRUMENTS.find((s) => s.id === id);
}

/**
 * Which surfaces can stream. Kept as one set rather than a field on every spec
 * so there is a single line to change when a surface gains streaming.
 */
const STREAMABLE = new Set(['chat.completions', 'responses', 'messages', 'completions']);

export function isStreamable(spec: SurfaceSpec): boolean {
  return STREAMABLE.has(spec.id);
}

export const STREAMING_SURFACES: readonly SurfaceSpec[] = SURFACES.filter(isStreamable);

/**
 * Turns a body into its streaming form.
 *
 * `stream: true` is universal across both families. `stream_options` is
 * OpenAI-only, and only on chat completions — asking for it elsewhere is how
 * you get a 400 that looks like a gateway bug but is your own request.
 */
export function withStreaming(
  spec: SurfaceSpec,
  body: unknown,
  includeUsage = false,
): unknown {
  const base =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
  base['stream'] = true;
  if (includeUsage && spec.id === 'chat.completions') {
    base['stream_options'] = { include_usage: true };
  }
  return base;
}

// ── Reading responses ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Concatenates the text parts of an Anthropic-style content array. */
function joinContentParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const texts = parts
    .filter(isRecord)
    .map((part) => str(part['text']))
    .filter((t): t is string => t !== undefined);
  return texts.length > 0 ? texts.join('') : undefined;
}

export interface SurfaceOutput {
  /** The assistant text, when the surface produced one. */
  text?: string;
  /** A short description when there is no text to show (embeddings, counts). */
  note?: string;
  finishReason?: string;
}

/**
 * Pulls the human-readable result out of whichever response shape came back.
 * Every step is defensive: a shape change is a finding to display, not a crash.
 */
export function readOutput(surfaceId: string, body: unknown): SurfaceOutput {
  if (!isRecord(body)) return {};

  if (surfaceId === 'chat.completions') {
    const choices = body['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return {};
    const first = choices[0];
    if (!isRecord(first)) return {};
    const message = first['message'];
    const text = isRecord(message)
      ? (str(message['content']) ?? joinContentParts(message['content']))
      : undefined;
    const out: SurfaceOutput = {};
    if (text !== undefined) out.text = text;
    const finish = str(first['finish_reason']);
    if (finish !== undefined) out.finishReason = finish;
    if (choices.length > 1) out.note = `${choices.length} choices returned; showing the first.`;
    return out;
  }

  if (surfaceId === 'completions') {
    const choices = body['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return {};
    const first = choices[0];
    if (!isRecord(first)) return {};
    const out: SurfaceOutput = {};
    const text = str(first['text']);
    if (text !== undefined) out.text = text;
    const finish = str(first['finish_reason']);
    if (finish !== undefined) out.finishReason = finish;
    return out;
  }

  if (surfaceId === 'responses') {
    // Two shapes in the wild: a convenience `output_text`, or the structured
    // `output[].content[].text`.
    const direct = str(body['output_text']);
    if (direct !== undefined) return { text: direct };
    const output = body['output'];
    if (Array.isArray(output)) {
      const chunks: string[] = [];
      for (const item of output) {
        if (!isRecord(item)) continue;
        const joined = joinContentParts(item['content']);
        if (joined !== undefined) chunks.push(joined);
      }
      if (chunks.length > 0) return { text: chunks.join('') };
    }
    const status = str(body['status']);
    return status !== undefined ? { note: `status: ${status}` } : {};
  }

  if (surfaceId === 'messages') {
    const text = joinContentParts(body['content']);
    const out: SurfaceOutput = {};
    if (text !== undefined) out.text = text;
    const stop = str(body['stop_reason']);
    if (stop !== undefined) out.finishReason = stop;
    return out;
  }

  if (surfaceId === 'embeddings') {
    const data = body['data'];
    if (!Array.isArray(data) || data.length === 0) return {};
    const first = data[0];
    const vector = isRecord(first) ? first['embedding'] : undefined;
    if (!Array.isArray(vector)) return { note: `${data.length} embedding(s) returned.` };
    const head = vector
      .slice(0, 6)
      .map((v) => (typeof v === 'number' ? v.toFixed(5) : String(v)))
      .join(', ');
    return {
      note: `${data.length} vector(s), ${vector.length} dimensions. First values: [${head}, …]`,
    };
  }

  if (surfaceId === 'messages.count_tokens' || surfaceId === 'tokens.count') {
    const keys = ['input_tokens', 'token_count', 'tokens', 'count', 'total_tokens'];
    for (const key of keys) {
      const value = body[key];
      if (typeof value === 'number') return { note: `${key}: ${value}` };
    }
    return {};
  }

  if (surfaceId === 'moderations') {
    const results = body['results'];
    if (Array.isArray(results) && results.length > 0) {
      const first = results[0];
      const flagged = isRecord(first) ? first['flagged'] : undefined;
      return { note: `flagged: ${String(flagged)}` };
    }
    return {};
  }

  return {};
}

export interface UsageSummary {
  input?: number;
  output?: number;
  total?: number;
  /** Anything else the gateway reported, kept verbatim for the inspector. */
  raw: unknown;
}

/**
 * Normalises token usage across naming schemes: OpenAI reports
 * prompt/completion, Anthropic reports input/output. The console shows one row
 * either way.
 */
export function readUsage(body: unknown): UsageSummary | undefined {
  if (!isRecord(body)) return undefined;
  const usage = body['usage'];
  if (!isRecord(usage)) return undefined;

  const num = (key: string): number | undefined =>
    typeof usage[key] === 'number' ? (usage[key] as number) : undefined;

  const input = num('prompt_tokens') ?? num('input_tokens');
  const output = num('completion_tokens') ?? num('output_tokens');
  const total = num('total_tokens') ?? (input !== undefined && output !== undefined ? input + output : undefined);

  const summary: UsageSummary = { raw: usage };
  if (input !== undefined) summary.input = input;
  if (output !== undefined) summary.output = output;
  if (total !== undefined) summary.total = total;
  return summary;
}
