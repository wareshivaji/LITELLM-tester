import { createSuite } from './_harness.mjs';

import { checkMcpItems, checkResponsesLifecycle } from '../dist/index.js';

const { check, truthy, done } = createSuite('responses lifecycle + tool listing');

// Checks mined from LiteLLM v1.100.0's own regression tests, Phase 4:
//   test_streaming_mcp_event_order_and_response_id_consistency
//   test_no_duplicate_mcp_tools_in_streaming_e2e

let seq = 0;
const ev = (type, extra = {}) => ({
  seq: (seq += 1),
  t: seq,
  raw: '',
  parsed: { type, ...extra },
});
const withId = (type, id) => ev(type, { response: { id } });

// ── a well-formed stream ────────────────────────────────────────────────────

const good = checkResponsesLifecycle([
  withId('response.created', 'resp_A'),
  withId('response.in_progress', 'resp_A'),
  ev('response.output_item.added'),
  ev('response.mcp_list_tools.in_progress'),
  ev('response.mcp_list_tools.completed'),
  ev('response.output_text.delta', { delta: 'hi' }),
  withId('response.completed', 'resp_A'),
]);
check('a conformant stream passes', good.ok, true);
check('nothing missing', good.missing, []);
check('no problems', good.problems, []);
check('one response id', good.responseIds, ['resp_A']);
check('one created, one completed', [good.createdCount, good.completedCount], [1, 1]);

// ── response.in_progress: the event we were not checking at all ─────────────

const noInProgress = checkResponsesLifecycle([
  withId('response.created', 'resp_A'),
  ev('response.output_item.added'),
  withId('response.completed', 'resp_A'),
]);
check('a missing response.in_progress is reported', noInProgress.missing, ['response.in_progress']);
check('and that alone fails the stream', noInProgress.ok, false);

check(
  'a missing terminal event is reported too',
  checkResponsesLifecycle([
    withId('response.created', 'resp_A'),
    withId('response.in_progress', 'resp_A'),
    ev('response.output_item.added'),
  ]).missing,
  ['response.completed'],
);

// ── ordering ────────────────────────────────────────────────────────────────

const wrongOrder = checkResponsesLifecycle([
  withId('response.in_progress', 'resp_A'),
  withId('response.created', 'resp_A'),
  ev('response.output_item.added'),
  withId('response.completed', 'resp_A'),
]);
truthy(
  'created arriving after in_progress is reported',
  wrongOrder.problems.some((p) => p.includes('response.created arrived after response.in_progress')),
);

// MCP events belong INSIDE an output item, so the item must open first.
const mcpTooEarly = checkResponsesLifecycle([
  withId('response.created', 'resp_A'),
  withId('response.in_progress', 'resp_A'),
  ev('response.mcp_list_tools.in_progress'),
  ev('response.output_item.added'),
  withId('response.completed', 'resp_A'),
]);
truthy(
  'an MCP listing event before output_item.added is reported',
  mcpTooEarly.problems.some((p) => p.includes('belong inside an output item')),
);

// A missing event must NOT also produce a bogus ordering complaint about
// itself — that would report one defect twice and bury the real one.
check(
  'a missing event is reported once, not as an ordering violation too',
  noInProgress.problems,
  [],
);

// ── the response id, where we are deliberately STRICTER than LiteLLM ────────
// Their test groups events into "cycles" and only requires consistency within
// a cycle, because a two-round LiteLLM conversation emits two created/completed
// pairs with different ids in one stream. That is not the shape a Responses
// stream is defined to have. We assert exactly one of each.

const twoCycles = checkResponsesLifecycle([
  withId('response.created', 'resp_A'),
  withId('response.in_progress', 'resp_A'),
  ev('response.output_item.added'),
  withId('response.completed', 'resp_A'),
  withId('response.created', 'resp_B'),
  withId('response.in_progress', 'resp_B'),
  withId('response.completed', 'resp_B'),
]);
check('two lifecycle cycles are counted', [twoCycles.createdCount, twoCycles.completedCount], [2, 2]);
check('both ids are collected', twoCycles.responseIds, ['resp_A', 'resp_B']);
check('and it FAILS, unlike the LiteLLM test it came from', twoCycles.ok, false);
truthy(
  'the duplicate created is named',
  twoCycles.problems.some((p) => p.includes('2 response.created events')),
);
truthy(
  'and the id divergence is named with the ids',
  twoCycles.problems.some((p) => p.includes('resp_A') && p.includes('resp_B')),
);

// ── robustness: a real stream carries frames this reader must ignore ────────

check(
  'comments, non-JSON frames and untyped payloads are skipped, not crashed on',
  checkResponsesLifecycle([
    { seq: 1, t: 1, raw: ': keep-alive', comment: true },
    { seq: 2, t: 2, raw: 'garbage' },
    { seq: 3, t: 3, raw: '{}', parsed: {} },
    { seq: 4, t: 4, raw: '[]', parsed: [] },
    withId('response.created', 'resp_A'),
    withId('response.in_progress', 'resp_A'),
    ev('response.output_item.added'),
    withId('response.completed', 'resp_A'),
  ]).ok,
  true,
);
check('an empty stream reports every required event missing', checkResponsesLifecycle([]).missing.length, 4);

// A lifecycle event with no response object must not invent an id.
check(
  'a lifecycle event carrying no response object contributes no id',
  checkResponsesLifecycle([
    ev('response.created'),
    ev('response.in_progress'),
    ev('response.output_item.added'),
    ev('response.completed'),
  ]).responseIds,
  [],
);

// ── duplicate tool names, from test_no_duplicate_mcp_tools_in_streaming_e2e ─
// LiteLLM had this exact bug: the parent handler processed MCP tools once and
// the streaming iterator processed them again.

const listing = (tools) => ({
  output: [{ type: 'mcp_list_tools', id: 'x', server_label: 'S', tools }],
});

const dupes = checkMcpItems(
  listing([
    { name: 'search', description: 'd', input_schema: {} },
    { name: 'search', description: 'd', input_schema: {} },
    { name: 'fetch', description: 'd', input_schema: {} },
  ]),
);
truthy('a duplicated tool name is reported', dupes.some((i) => i.kind === 'duplicate-tool-name'));
truthy(
  'and it names the offending tool, not just a count',
  dupes.some((i) => i.kind === 'duplicate-tool-name' && i.detail.includes('search')),
);
truthy('fetch is not accused', !dupes.some((i) => i.detail.includes('fetch')));

check(
  'a clean listing reports no duplicate',
  checkMcpItems(
    listing([
      { name: 'search', description: 'd', input_schema: {} },
      { name: 'fetch', description: 'd', input_schema: {} },
    ]),
  ).filter((i) => i.kind === 'duplicate-tool-name'),
  [],
);

// ── missing description — LiteLLM asserts name, description AND parameters ──

const noDesc = checkMcpItems(listing([{ name: 'search', input_schema: {} }]));
truthy('a tool with no description is reported', noDesc.some((i) => i.kind === 'missing-description'));
truthy(
  'and the reason is given, not just the fact',
  noDesc.some((i) => i.kind === 'missing-description' && i.detail.includes('how the model decides')),
);
check(
  'an empty-string description counts as missing',
  checkMcpItems(listing([{ name: 'search', description: '', input_schema: {} }]))
    .filter((i) => i.kind === 'missing-description').length,
  1,
);
check(
  'a complete tool raises nothing at all',
  checkMcpItems(listing([{ name: 'search', description: 'Finds things', input_schema: {} }])),
  [],
);

done();
