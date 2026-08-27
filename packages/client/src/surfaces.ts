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
    id: 'messages',
    label: 'Messages (Anthropic)',
    path: '/v1/messages',
    method: 'POST',
    family: 'anthropic',
    needsModel: true,
    docs: 'What Claude CLI, Claude Desktop and the Anthropic SDKs speak. Different error envelope.',
    sample: (model, prompt) => ({
      model,
      max_tokens: 128,
      messages: [{ role: 'user', content: prompt }],
    }),
  },
  {
    id: 'completions',
    label: 'Text Completions',
    path: '/v1/completions',
    method: 'POST',
    family: 'openai',
    needsModel: true,
    docs: 'The legacy prompt-in, text-out endpoint.',
    sample: (model, prompt) => ({ model, prompt, max_tokens: 64 }),
  },
  {
    id: 'embeddings',
    label: 'Embeddings',
    path: '/v1/embeddings',
    method: 'POST',
    family: 'openai',
    needsModel: true,
    docs: 'Needs an embedding model — a chat model here is expected to fail.',
    sample: (model, prompt) => ({ model, input: prompt }),
  },
  {
    id: 'messages.count_tokens',
    label: 'Count Tokens (Anthropic)',
    path: '/v1/messages/count_tokens',
    method: 'POST',
    family: 'anthropic',
    needsModel: true,
    docs: 'Token count without generating. No provider spend.',
    sample: (model, prompt) => ({ model, messages: [{ role: 'user', content: prompt }] }),
  },
  {
    id: 'tokens.count',
    label: 'Count Tokens',
    path: '/v1/tokens/count',
    method: 'POST',
    family: 'utility',
    needsModel: true,
    docs: 'Gateway-specific counter. Request shape is undocumented — probing it is the point.',
    sample: chatSample,
  },
  {
    id: 'moderations',
    label: 'Moderations',
    path: '/v1/moderations',
    method: 'POST',
    family: 'openai',
    needsModel: false,
    docs: 'Content classification endpoint.',
    sample: (_model, prompt) => ({ input: prompt }),
  },
];

export function surfaceById(id: string): SurfaceSpec | undefined {
  return SURFACES.find((s) => s.id === id);
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
