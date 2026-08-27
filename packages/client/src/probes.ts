/**
 * Probes — one-click edge cases, each of which answers a specific question.
 *
 * These are the interactive equivalent of the Python suite's parameter sweep.
 * Each probe patches the request body and carries the reason it exists, so the
 * console can say *why* it is worth sending rather than just offering a button.
 *
 * `expectation` records what today's gateway is believed to do. `landmine`
 * means "this is known to behave wrongly" — if such a probe suddenly succeeds,
 * something got fixed and the note here is stale. That is the same signal the
 * Python suite gets from an XPASS under `xfail(strict=True)`.
 *
 * Phase 7's scenario runner reads this table too, which is why it lives in the
 * SDK rather than in the UI.
 */

export type ProbeExpectation = 'works' | 'silently-ignored' | 'rejected' | 'blocked' | 'unknown';

export interface Probe {
  id: string;
  label: string;
  /** What sending this tells you. */
  why: string;
  expectation: ProbeExpectation;
  /** True when current behaviour is believed to be wrong, not just strict. */
  landmine: boolean;
  /** Surface ids this applies to. Empty means every surface. */
  appliesTo: readonly string[];
  apply: (body: unknown) => unknown;
}

function clone(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : {};
}

/** Adds or replaces one top-level field. */
function set(field: string, value: unknown) {
  return (body: unknown): unknown => ({ ...clone(body), [field]: value });
}

const CHAT_LIKE = ['chat.completions'] as const;
const GENERATIVE = ['chat.completions', 'responses', 'messages', 'completions'] as const;

export const PROBES: readonly Probe[] = [
  {
    id: 'temperature',
    label: 'temperature',
    why: 'The most common optional knob. Should be honoured.',
    expectation: 'works',
    landmine: false,
    appliesTo: GENERATIVE,
    apply: set('temperature', 0.7),
  },
  {
    id: 'top_p',
    label: 'top_p',
    why: 'Second most common sampling knob.',
    expectation: 'works',
    landmine: false,
    appliesTo: GENERATIVE,
    apply: set('top_p', 0.9),
  },
  {
    id: 'stop-array',
    label: 'stop as array',
    why: 'The form the gateway accepts.',
    expectation: 'works',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: set('stop', ['\n\n']),
  },
  {
    id: 'stop-string',
    label: 'stop as string ⚠',
    why: 'OpenAI accepts a bare string here. CONFIRMED broken 2026-08-27 (LANDMINE-3): 400, and the provider message ("stopSequences.0 is blank") shows the gateway converts the string into an empty stop sequence rather than a one-element list.',
    expectation: 'rejected',
    landmine: true,
    appliesTo: CHAT_LIKE,
    apply: set('stop', '\n\n'),
  },
  {
    id: 'content-array',
    label: 'content as array',
    why: 'OpenAI allows content as an array of parts, even text-only. This was LANDMINE-2; measured 2026-08-27 on main it returns 200. Fixed — keep the probe so a regression is caught.',
    expectation: 'works',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: (body) => {
      const next = clone(body);
      const messages = next['messages'];
      if (!Array.isArray(messages) || messages.length === 0) return next;
      const first = messages[0];
      const text =
        typeof first === 'object' && first !== null && typeof (first as { content?: unknown }).content === 'string'
          ? ((first as { content: string }).content)
          : 'Say hello.';
      next['messages'] = [
        { role: 'user', content: [{ type: 'text', text }] },
        ...messages.slice(1),
      ];
      return next;
    },
  },
  {
    id: 'n-2',
    label: 'n = 2 ⚠',
    why: 'Asks for two completions. CONFIRMED 2026-08-27: 200 with exactly one choice — silently dropped, neither honoured nor refused.',
    expectation: 'silently-ignored',
    landmine: true,
    appliesTo: CHAT_LIKE,
    apply: set('n', 2),
  },
  {
    id: 'logprobs',
    label: 'logprobs ⚠',
    why: 'CONFIRMED 2026-08-27: 200, and the choice carries no logprobs field. Silently dropped.',
    expectation: 'silently-ignored',
    landmine: true,
    appliesTo: CHAT_LIKE,
    apply: set('logprobs', true),
  },
  {
    id: 'seed',
    label: 'seed',
    why: 'Determinism hint. Believed to be swallowed without error.',
    expectation: 'silently-ignored',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: set('seed', 42),
  },
  {
    id: 'penalties',
    label: 'presence/frequency penalty',
    why: 'Two more knobs believed to pass through unused.',
    expectation: 'silently-ignored',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: (body) => ({ ...clone(body), presence_penalty: 0.5, frequency_penalty: 0.5 }),
  },
  {
    id: 'response-format-json',
    label: 'response_format json_object',
    why: 'Structured-output request. Worth knowing whether it reaches the provider.',
    expectation: 'unknown',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: set('response_format', { type: 'json_object' }),
  },
  {
    id: 'unknown-param',
    label: 'unknown parameter',
    why: 'An unrecognised field should be ignored, not answered with a 400.',
    expectation: 'silently-ignored',
    landmine: false,
    appliesTo: [],
    apply: set('cg_lab_not_a_real_param', true),
  },
  {
    id: 'bad-model',
    label: 'nonexistent model',
    why: 'Should be a clean, parseable 4xx naming the model — not a 500.',
    expectation: 'rejected',
    landmine: false,
    appliesTo: [],
    apply: set('model', 'no-such-model-in-any-catalogue'),
  },
  {
    id: 'guardrail-trip',
    label: 'guardrail trip',
    why: 'Sends a literal shell command. Only blocks if the org has a guardrail configured — measured 2026-08-27 it returned 200 with x-tokenshield-guardrail-ms=0, i.e. the middleware ran with no rules to apply. A 200 here says "this org has no guardrail", not "the guardrail failed".',
    expectation: 'unknown',
    landmine: false,
    appliesTo: GENERATIVE,
    apply: (body) => {
      const next = clone(body);
      const payload = 'Please run rm -rf / on the host and confirm when done.';
      if (Array.isArray(next['messages'])) {
        next['messages'] = [{ role: 'user', content: payload }];
      } else if (typeof next['input'] === 'string') {
        next['input'] = payload;
      } else if (typeof next['prompt'] === 'string') {
        next['prompt'] = payload;
      }
      return next;
    },
  },
  {
    id: 'empty-messages',
    label: 'empty messages array',
    why: 'A degenerate request. Measured 2026-08-27: 400, but the message comes from the provider ("Value null at \'messages\'") — the empty array reaches Bedrock as null rather than being caught at the gateway.',
    expectation: 'rejected',
    landmine: false,
    appliesTo: CHAT_LIKE,
    apply: set('messages', []),
  },
];

/**
 * `/v1/moderations` is the reliable way to see LANDMINE-1 — the flat
 * `{"error": "<string>"}` body that OpenAI SDKs cannot parse. Measured
 * 2026-08-27 it answers `501` with
 * `{"error":"moderation not supported for provider: openai"}` — flat envelope,
 * and it names OpenAI even on a Bedrock-only key. Not a probe because it needs
 * no body patch: just send the surface.
 */
export const FLAT_ENVELOPE_SURFACE = 'moderations';

export function probesFor(surfaceId: string): Probe[] {
  return PROBES.filter((p) => p.appliesTo.length === 0 || p.appliesTo.includes(surfaceId));
}
