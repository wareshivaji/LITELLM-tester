import { createSuite } from './_harness.mjs';

import {
  CHAT_FIELDS,
  FIELD_GAPS,
  fieldsFor,
  gapsMovingTo,
  isUnknownField,
  RESPONSES_FIELDS,
  sharedFields,
  unknownFieldsIn,
} from '../dist/index.js';

const { check, truthy, done } = createSuite('surface field contracts');

// The lists are transcribed from LiteLLM v1.100.0 source. These tests exist to
// catch a transcription slip, and to pin the asymmetries that matter to a
// client — not to restate the lists.

truthy('both surfaces require a model', CHAT_FIELDS.includes('model') && RESPONSES_FIELDS.includes('model'));
truthy('chat carries messages', CHAT_FIELDS.includes('messages'));
truthy('responses carries input, not messages', RESPONSES_FIELDS.includes('input') && !RESPONSES_FIELDS.includes('messages'));

// ── the asymmetries, which are the whole point ──────────────────────────────

check(
  'the token cap is RENAMED between surfaces, not shared',
  [CHAT_FIELDS.includes('max_tokens'), RESPONSES_FIELDS.includes('max_tokens'),
   RESPONSES_FIELDS.includes('max_output_tokens'), CHAT_FIELDS.includes('max_output_tokens')],
  [true, false, true, false],
);

// The expensive one. `max_tokens` on Responses is not an error a client sees —
// it is a field that does nothing, so nothing caps the answer.
truthy('max_tokens is out of contract on responses', isUnknownField('responses', 'max_tokens'));
truthy('and max_output_tokens is out of contract on chat', isUnknownField('chat.completions', 'max_output_tokens'));

// Seven capabilities vanish moving to Responses with no replacement at all.
const gone = gapsMovingTo('responses').filter((g) => g.equivalent === null).map((g) => g.field);
for (const f of ['stop', 'n', 'seed', 'logit_bias', 'frequency_penalty', 'presence_penalty']) {
  truthy(`moving to responses loses ${f} entirely`, gone.includes(f));
}
truthy('stop really is absent from the responses contract', !RESPONSES_FIELDS.includes('stop'));

// And the other direction.
const lostLeavingResponses = gapsMovingTo('chat.completions').map((g) => g.field);
for (const f of ['instructions', 'previous_response_id', 'store', 'truncation']) {
  truthy(`moving to chat loses ${f}`, lostLeavingResponses.includes(f));
}

check(
  'a gap is attributed to the surface that HAS the field',
  FIELD_GAPS.filter((g) => g.field === 'stop').map((g) => g.on),
  ['chat.completions'],
);
check(
  'and instructions is attributed to responses',
  FIELD_GAPS.filter((g) => g.field === 'instructions').map((g) => g.on),
  ['responses'],
);

truthy('every gap says what it costs', FIELD_GAPS.every((g) => g.consequence.length > 20));
truthy(
  'every gap names a surface the contract is known for',
  FIELD_GAPS.every((g) => g.on === 'chat.completions' || g.on === 'responses'),
);
truthy(
  'a gap field is genuinely absent from the OTHER surface',
  FIELD_GAPS.every((g) =>
    g.on === 'chat.completions' ? !RESPONSES_FIELDS.includes(g.field) : !CHAT_FIELDS.includes(g.field),
  ),
);

// ── what a port carries unchanged ───────────────────────────────────────────

const shared = sharedFields();
for (const f of ['model', 'temperature', 'top_p', 'tools', 'tool_choice', 'user', 'metadata', 'parallel_tool_calls']) {
  truthy(`${f} survives a port`, shared.includes(f));
}
truthy('messages does NOT survive a port', !shared.includes('messages'));

// ── catching a ported body ──────────────────────────────────────────────────
// The real mistake: copy a working chat body onto Responses and leave fields
// behind. Reporting them is not the same as claiming the gateway rejects them.

check(
  'a chat body sent at responses reports every field left behind',
  unknownFieldsIn('responses', {
    model: 'm',
    input: [],
    max_tokens: 16,
    stop: ['\n'],
    seed: 7,
    n: 2,
  }),
  ['max_tokens', 'n', 'seed', 'stop'],
);

check(
  'a clean responses body reports nothing',
  unknownFieldsIn('responses', { model: 'm', input: [], max_output_tokens: 16, store: false }),
  [],
);

check(
  'a clean chat body reports nothing',
  unknownFieldsIn('chat.completions', { model: 'm', messages: [], max_tokens: 16, stop: '\n' }),
  [],
);

// A surface whose contract this module does not hold must NOT be told its
// fields are invalid — silence is the honest answer, not a false accusation.
check(
  'an unknown surface claims nothing about its fields',
  unknownFieldsIn('mcp.aggregate', { jsonrpc: '2.0', method: 'tools/list' }),
  [],
);
check('and isUnknownField stays false there', isUnknownField('mcp.aggregate', 'anything'), false);
check('fieldsFor is empty for a surface with no known contract', fieldsFor('mcp.servers'), []);

check('a non-object body reports nothing rather than throwing', unknownFieldsIn('responses', null), []);
check('nor does an array', unknownFieldsIn('responses', [1, 2]), []);

done();
