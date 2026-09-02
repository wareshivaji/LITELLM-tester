import { createSuite } from './_harness.mjs';

import {
  checkMcpItems,
  evaluatePromptOutcome,
  extractResponsesToolCalls,
  offeredToolNames,
  readMcpBrokeredCalls,
  readMcpListings,
} from '../dist/index.js';

const { check, truthy, done } = createSuite('buffered MCP items');

// A real brokered response, trimmed. Captured from a live org 2026-09-01.
const real = {
  id: 'resp_b776',
  object: 'response',
  status: 'completed',
  model: 'zai.glm-4.7-flash',
  output: [
    {
      type: 'mcp_list_tools',
      id: 'mcp_tools',
      status: 'completed',
      server_label: 'HuggingFace,MS Learn,Cloudflare docs',
      tools: [
        { name: 'hf_whoami', description: 'd', server_label: 'HuggingFace' },
        { name: 'hub_repo_search', description: 'd', server_label: 'HuggingFace' },
        { name: 'microsoft_docs_search', description: 'd', server_label: 'MS Learn' },
      ],
    },
    {
      type: 'mcp_call',
      id: 'mcp_1',
      status: 'completed',
      name: 'hub_repo_search',
      arguments: '{"limit":3,"query":"distilbert"}',
      server_label: 'HuggingFace',
      output: 'Found 3 repositories',
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Top 3 DistilBERT models' }],
    },
  ],
};

// ── the gap this closes ─────────────────────────────────────────────────────
// A brokered call used to read as "no tool calls at all", because the only
// Responses extractor matched `function_call`. That reported a wrong answer
// that looked like a real result.

check(
  'a brokered mcp_call is NOT a function_call and must not be read as one',
  extractResponsesToolCalls(real),
  [],
);

const calls = readMcpBrokeredCalls(real);
check('the brokered call is found', calls.length, 1);
check('with its name', calls[0].name, 'hub_repo_search');
check('and the server that ran it', calls[0].serverLabel, 'HuggingFace');
check('arguments are parsed', calls[0].argumentsParsed, { limit: 3, query: 'distilbert' });
check('a clean output is not flagged truncated', calls[0].truncated, false);
check('the non-standard status is recorded rather than dropped', calls[0].status, 'completed');

// ── the offered listing ─────────────────────────────────────────────────────

const listings = readMcpListings(real);
check('the listing is found', listings.length, 1);
check(
  'a comma-joined server_label is split so the names are recoverable',
  listings[0].serverLabels,
  ['HuggingFace', 'MS Learn', 'Cloudflare docs'],
);
check('offered tools are read', offeredToolNames(real), [
  'hf_whoami',
  'hub_repo_search',
  'microsoft_docs_search',
]);
check('and every one is flagged as carrying no schema', listings[0].tools.every((t) => !t.hasInputSchema), true);

// The flat MCP endpoint spells it `tool`, the item spells it `name`, and a
// schema may arrive under either casing. All four combinations must read.
check(
  'the flat spelling is accepted too',
  readMcpListings({
    output: [
      { type: 'mcp_list_tools', id: 'x', server_label: 'S', tools: [{ tool: 'a', input_schema: {} }] },
    ],
  })[0].tools[0],
  { name: 'a', hasInputSchema: true },
);
check(
  'and camelCase inputSchema counts as present',
  readMcpListings({
    output: [
      { type: 'mcp_list_tools', id: 'x', server_label: 'S', tools: [{ name: 'a', inputSchema: {} }] },
    ],
  })[0].tools[0].hasInputSchema,
  true,
);

// ── contract issues ─────────────────────────────────────────────────────────

const kinds = checkMcpItems(real).map((i) => i.kind);
truthy('the comma-joined server_label is reported', kinds.includes('server-label-is-a-list'));
truthy('the missing input_schema is reported', kinds.includes('missing-input-schema'));
truthy('the non-standard status is reported', kinds.includes('nonstandard-status'));

// The fixture gained a description when the missing-description check landed
// (Phase 4, from LiteLLM's assertion that every offered tool carries name,
// description AND parameters). The old fixture was incomplete, not the check
// wrong — a tool with no description is genuinely near-unusable to a model.
check(
  'a single-server label with COMPLETE tools is reported clean',
  checkMcpItems({
    output: [
      {
        type: 'mcp_list_tools',
        id: 'x',
        server_label: 'OnlyOne',
        tools: [{ name: 'a', description: 'Does a thing', input_schema: {} }],
      },
    ],
  }).map((i) => i.kind),
  [],
);

// That body has a call and no listing, so it legitimately raises TWO issues.
// Asserting exact equality here was wrong, not the code.
check(
  'the gateway truncation marker is detected in a tool output',
  checkMcpItems({
    output: [
      { type: 'mcp_call', id: 'c', name: 't', arguments: '{}', server_label: 'S',
        output: 'a lot of text [... truncated by the gateway]' },
    ],
  }).map((i) => i.kind).sort(),
  ['listing-absent-though-tool-ran', 'output-truncated'],
);

check(
  'a tool that ran with no listing at all is reported',
  checkMcpItems({
    output: [{ type: 'mcp_call', id: 'c', name: 't', arguments: '{}', server_label: 'S', output: 'x' }],
  }).some((i) => i.kind === 'listing-absent-though-tool-ran'),
  true,
);

check('a body with no MCP items yields no issues', checkMcpItems({ output: [] }), []);
check('a malformed body does not throw', readMcpBrokeredCalls(null), []);
check('nor does a missing output array', readMcpListings({ output: 'nope' }), []);

// ── the prompt outcome now sees brokered work ───────────────────────────────

const exchange = (body) => ({
  id: 'x',
  timings: { totalMs: 10 },
  response: { status: 200, headers: {}, body },
});

const brokered = {
  id: 'b', title: 'B', why: '', prompt: 'p', maxTokens: 16,
  expect: { brokersTool: 'hub_repo_search' },
};
const outcome = evaluatePromptOutcome('responses', brokered, exchange(real));
check('a brokersTool expectation is met by a real brokered call', outcome.ok, true);
check('and the call is carried on the outcome', outcome.brokeredCalls.length, 1);
check('client tool calls stay separate and empty', outcome.toolCalls, []);
check('the offered list is carried too', outcome.offeredTools.length, 3);
truthy('and the contract issues ride along', outcome.mcpIssues.length > 0);

check(
  'expecting the wrong brokered tool fails, naming what did run',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { brokersTool: 'hf_fs' } },
    exchange(real),
  ).failures,
  ['expected the gateway to run "hf_fs", it ran hub_repo_search'],
);

// Proving a BLOCK: the tool must be absent from a listing that EXISTS.
check(
  'a withheld tool absent from a real listing passes',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: 'hf_fs' } },
    exchange(real),
  ).ok,
  true,
);
check(
  'a tool that IS offered fails a withholds expectation',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: 'hub_repo_search' } },
    exchange(real),
  ).ok,
  false,
);

// The important guard. With no listing there is nothing to be absent FROM, so
// treating that as proof of blocking would report "blocked" for any response
// that simply never listed anything — which is most of them.
check(
  'no listing means withholding is UNPROVEN, not proven',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: 'hf_fs' } },
    exchange({ output: [{ type: 'message', content: [{ text: 'hi' }] }] }),
  ).failures,
  ['cannot tell whether "hf_fs" was withheld: no mcp_list_tools item was emitted'],
);

check(
  'an offersTool expectation says so plainly when nothing was listed',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { offersTool: 'hub_repo_search' } },
    exchange({ output: [] }),
  ).failures,
  ['expected "hub_repo_search" to be offered, but no mcp_list_tools item was emitted at all'],
);

// Chat emits no transparency items at all, so brokered work is invisible there
// by construction. The reader must return empty rather than inventing anything.
check(
  'a chat body yields no brokered calls',
  readMcpBrokeredCalls({ choices: [{ message: { content: 'hi' } }] }),
  [],
);

// ── array expectations (Phase 5) ─────────────────────────────────────────────
// One case proves BOTH blocked tools, which is how the real org is shaped: two
// BLOCKs across two different servers.

check(
  'several withheld tools are all checked, and a clean listing passes',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: ['hf_fs', 'microsoft_docs_fetch'] } },
    exchange(real),
  ).ok,
  true,
);

check(
  'only the leaked one is named, not every tool asked about',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: ['hf_fs', 'hub_repo_search'] } },
    exchange(real),
  ).failures,
  ['expected "hub_repo_search" to be withheld, but it was offered'],
);

check(
  'several offered tools are all required',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { offersTool: ['hub_repo_search', 'microsoft_docs_search'] } },
    exchange(real),
  ).ok,
  true,
);

check(
  'and a missing one is named while the present ones are not',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { offersTool: ['hub_repo_search', 'not_a_tool'] } },
    exchange(real),
  ).failures[0]
    .startsWith('expected "not_a_tool" to be offered'),
  true,
);

// The guard still holds for a list: no listing means UNPROVEN, not proven.
check(
  'with no listing, a list of withheld tools reports cannot-tell for all of them',
  evaluatePromptOutcome(
    'responses',
    { ...brokered, expect: { withholdsTool: ['hf_fs', 'microsoft_docs_fetch'] } },
    exchange({ output: [{ type: 'message', content: [{ text: 'hi' }] }] }),
  ).failures,
  ['cannot tell whether "hf_fs", "microsoft_docs_fetch" were withheld: no mcp_list_tools item was emitted'],
);

done();
