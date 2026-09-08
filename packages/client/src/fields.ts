/**
 * The request fields each surface accepts, and what a client loses moving
 * between them.
 *
 * ## Where this comes from
 *
 * Read from LiteLLM v1.100.0 source at `~/Cloudgov/litellm`, not from
 * documentation and not from memory:
 *
 *  - chat: `litellm/types/llms/openai.py:1011` — `ChatCompletionRequest`
 *  - responses: `litellm/types/llms/openai.py:1231` —
 *    `ResponsesAPIOptionalRequestParams` plus `ResponsesAPIRequestParams`
 *
 * That is the strongest reference available for these two surfaces: LiteLLM's
 * entire product is being OpenAI-shaped, so its accepted-parameter set is a
 * checked statement of what an OpenAI-compatible gateway is expected to take.
 *
 * ## Why a list of field names is worth having at all
 *
 * The interesting fact is not either list — it is the **difference**. The two
 * surfaces are advertised as interchangeable ways to talk to the same model,
 * and they are not: seven fields a chat client relies on have no Responses
 * equivalent, so a customer porting a working request silently loses them.
 * Nothing errors. The request succeeds and behaves differently.
 *
 * `stop` is the clearest case. A chat client that ends generation on a stop
 * sequence, ported to Responses, gets a request that succeeds and ignores the
 * stop entirely.
 */

/**
 * Chat Completions, from `ChatCompletionRequest`.
 *
 * The last seven were added 2026-09-07 after checking this table against
 * LiteLLM IN-PROCESS rather than by re-reading its source: a hand transcription
 * rots silently, and `litellm_reference_test.py` in the compat repo now makes it
 * rot loudly instead. `litellm.get_supported_openai_params` declared all seven
 * and this list had none of them.
 *
 * `max_completion_tokens` is the one that matters. It is OpenAI's replacement
 * for `max_tokens`, so a client on a current SDK sends it as a matter of course
 * — and a reference table that does not know the field cannot tell you whether
 * the gateway honours it. None of the seven has had its gateway handling
 * measured yet; they are listed because they are part of the surface, not
 * because anything is known about them here.
 */
export const CHAT_FIELDS: readonly string[] = [
  'model',
  'messages',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'max_tokens',
  'n',
  'presence_penalty',
  'response_format',
  'seed',
  'service_tier',
  'safety_identifier',
  'prompt_cache_key',
  'stop',
  'stream_options',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'function_call',
  'functions',
  'user',
  'metadata',
  'reasoning_effort',
  'output_config',
  // Added 2026-09-07 from LiteLLM's own declaration. Gateway handling
  // unmeasured — see the note above.
  'max_completion_tokens',
  'store',
  'audio',
  'modalities',
  'prediction',
  'prompt_cache_retention',
  'web_search_options',
];

/** Responses, from `ResponsesAPIRequestParams`. */
export const RESPONSES_FIELDS: readonly string[] = [
  'model',
  'input',
  'include',
  'instructions',
  'max_output_tokens',
  'metadata',
  'parallel_tool_calls',
  'previous_response_id',
  'reasoning',
  'store',
  'background',
  'stream',
  'temperature',
  'text',
  'tool_choice',
  'tools',
  'top_p',
  'truncation',
  'user',
  'service_tier',
  'safety_identifier',
  'prompt',
  'max_tool_calls',
  'prompt_cache_key',
  'prompt_cache_retention',
  'prompt_cache_options',
  'stream_options',
  'top_logprobs',
  'partial_images',
  'context_management',
];

/**
 * Fields that exist on one surface and not the other, with what it costs.
 *
 * `equivalent` names the field to use instead where one exists. Where it is
 * `null` the capability is simply gone, which is the case worth knowing about:
 * the request still succeeds.
 */
export interface FieldGap {
  field: string;
  /** The surface that HAS it. */
  on: 'chat.completions' | 'responses';
  /** What to use on the other surface, or null when nothing replaces it. */
  equivalent: string | null;
  /** What a client loses, in client terms. */
  consequence: string;
}

export const FIELD_GAPS: readonly FieldGap[] = [
  {
    field: 'stop',
    on: 'chat.completions',
    equivalent: null,
    consequence:
      'Stop sequences are gone. A ported request succeeds and generates past where it used to stop.',
  },
  {
    field: 'n',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'No way to ask for several completions in one call; the caller must loop and pay per call.',
  },
  {
    field: 'seed',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'Reproducibility is gone, which breaks any test that pinned output by seed.',
  },
  {
    field: 'logit_bias',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'Token-level steering is gone.',
  },
  {
    field: 'frequency_penalty',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'Repetition control is gone.',
  },
  {
    field: 'presence_penalty',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'Topic-repetition control is gone.',
  },
  {
    field: 'response_format',
    on: 'chat.completions',
    equivalent: 'text',
    consequence:
      'JSON mode and schema enforcement move to `text`, a differently-shaped field — so the port is a rewrite, not a rename.',
  },
  {
    field: 'max_tokens',
    on: 'chat.completions',
    equivalent: 'max_output_tokens',
    consequence: 'Renamed. Sending the chat name on Responses caps nothing, so a runaway answer is billed in full.',
  },
  {
    field: 'logprobs',
    on: 'chat.completions',
    equivalent: null,
    consequence: 'Responses keeps `top_logprobs` but has no boolean `logprobs` toggle.',
  },
  {
    field: 'function_call',
    on: 'chat.completions',
    equivalent: 'tool_choice',
    consequence: 'The legacy pre-tools field. Absent on Responses, which only has `tool_choice`.',
  },
  {
    field: 'functions',
    on: 'chat.completions',
    equivalent: 'tools',
    consequence: 'The legacy pre-tools field. Absent on Responses.',
  },
  {
    field: 'instructions',
    on: 'responses',
    equivalent: 'a system message',
    consequence:
      'Responses has a first-class field for the system prompt. On chat the same thing is a message with role "system", so the two are not copy-paste compatible.',
  },
  {
    field: 'previous_response_id',
    on: 'responses',
    equivalent: null,
    consequence:
      'Server-side conversation continuation. Chat has no equivalent — the client resends the whole history every turn.',
  },  // REMOVED 2026-09-07. This claimed `store` had "no chat equivalent" and was
  // "a real data-residency question" — and it was wrong: OpenAI accepts `store`
  // on chat completions and LiteLLM declares it there. The error survived
  // because the chat table was missing the field, so nothing contradicted it;
  // adding the field made the fields.test.mjs invariant fail immediately.
  //
  // A gap entry that invents a difference is worse than a missing one: this one
  // framed a non-existent divergence as a data-residency decision someone could
  // have acted on.
  {
    field: 'truncation',
    on: 'responses',
    equivalent: null,
    consequence: 'Automatic history trimming. On chat the client must trim its own history or hit a context error.',
  },
  {
    field: 'background',
    on: 'responses',
    equivalent: null,
    consequence: 'Long-running asynchronous responses. No chat equivalent.',
  },
  {
    field: 'max_tool_calls',
    on: 'responses',
    equivalent: null,
    consequence: 'A cap on tool calls per response. Chat has none, so a tool loop is bounded only by the gateway.',
  },
  {
    field: 'include',
    on: 'responses',
    equivalent: null,
    consequence: 'Opt-in extra output. No chat equivalent.',
  },
];

/** Every field valid on this surface, per LiteLLM. */
export function fieldsFor(surfaceId: string): readonly string[] {
  if (surfaceId === 'responses') return RESPONSES_FIELDS;
  if (surfaceId === 'chat.completions') return CHAT_FIELDS;
  return [];
}

/**
 * True when a field is not part of this surface's accepted set.
 *
 * Only meaningful for the two surfaces with a known field list — anything else
 * returns false rather than claiming a field is invalid on a surface whose
 * contract this module does not hold.
 */
export function isUnknownField(surfaceId: string, field: string): boolean {
  const known = fieldsFor(surfaceId);
  return known.length > 0 && !known.includes(field);
}

/**
 * Fields in a body that the surface does not accept.
 *
 * The common real mistake this catches is porting a body between the two
 * surfaces and leaving a field behind — `stop` or `max_tokens` on a Responses
 * request, say. Whether the gateway rejects those or silently drops them is the
 * finding; this only reports that they are present and out of contract.
 */
export function unknownFieldsIn(surfaceId: string, body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>)
    .filter((k) => isUnknownField(surfaceId, k))
    .sort();
}

/** The gaps a client hits porting from one surface to the other. */
export function gapsMovingTo(surfaceId: 'chat.completions' | 'responses'): readonly FieldGap[] {
  // Moving TO responses, what hurts is what only chat has.
  const losing = surfaceId === 'responses' ? 'chat.completions' : 'responses';
  return FIELD_GAPS.filter((g) => g.on === losing);
}

/** Fields both surfaces accept, so a port carries them unchanged. */
export function sharedFields(): readonly string[] {
  return CHAT_FIELDS.filter((f) => RESPONSES_FIELDS.includes(f)).sort();
}
