import { createSuite } from './_harness.mjs';

import {
  buildPromptBody,
  comparePromptOutcomes,
  estimateRun,
  evaluatePromptOutcome,
  PROMPT_CASES,
  readAnswerText,
  summarisePromptResult,
} from '../dist/index.js';

const { check, truthy, done } = createSuite('prompt testing');

// ── building two requests from one prompt ───────────────────────────────────
// The whole point of the module: if the two bodies do not ask the same thing,
// any difference in the answers is meaningless.

const smoke = PROMPT_CASES.find((c) => c.id === 'smoke');
const opts = { model: 'test-model', mcpServerUrl: 'http://127.0.0.1:8787/mock-mcp' };

const chat = buildPromptBody('chat.completions', smoke, opts);
const resp = buildPromptBody('responses', smoke, opts);

check('chat uses messages[]', chat.messages[0], { role: 'user', content: smoke.prompt });
check('chat caps with max_tokens', chat.max_tokens, smoke.maxTokens);
check('responses caps with max_output_tokens', resp.max_output_tokens, smoke.maxTokens);
check(
  'responses uses the EXPLICIT message item, not the shorthand',
  resp.input[0].type,
  'message',
);
check(
  'and wraps the text in an input_text content part',
  resp.input[0].content[0],
  { type: 'input_text', text: smoke.prompt },
);
check('the same prompt text reaches both', chat.messages[0].content, resp.input[0].content[0].text);
truthy('neither declares tools when the case asks for none', chat.tools === undefined && resp.tools === undefined);

// A system turn has to survive both encodings, or a customer's guardrails
// silently stop applying on one surface.
const sys = PROMPT_CASES.find((c) => c.id === 'system-honoured');
const chatSys = buildPromptBody('chat.completions', sys, opts);
const respSys = buildPromptBody('responses', sys, opts);
check('chat puts system first', chatSys.messages[0].role, 'system');
check('responses puts system first too', respSys.input[0].role, 'system');
check('and both carry the same instruction', chatSys.messages[0].content, respSys.input[0].content[0].text);
check('the user turn still follows', chatSys.messages[1].role, 'user');

// The tool shapes are NOT interchangeable — nested on chat, flat on responses.
const tooled = PROMPT_CASES.find((c) => c.id === 'tool-offered');
const chatTool = buildPromptBody('chat.completions', tooled, opts);
const respTool = buildPromptBody('responses', tooled, opts);
check('chat nests the name under function', chatTool.tools[0].function.name, 'get_weather');
check('responses carries it flat', respTool.tools[0].name, 'get_weather');
truthy('the chat shape has no top-level name', chatTool.tools[0].name === undefined);
truthy('the responses shape has no function wrapper', respTool.tools[0].function === undefined);

// The MCP block is the same on both, which is what LiteLLM documents.
const mcpCase = PROMPT_CASES.find((c) => c.id === 'mcp-brokered');
const chatMcp = buildPromptBody('chat.completions', mcpCase, opts);
const respMcp = buildPromptBody('responses', mcpCase, opts);
check('the MCP block is identical across surfaces', chatMcp.tools[0], respMcp.tools[0]);
check('and points at the lab server', chatMcp.tools[0].server_url, opts.mcpServerUrl);
check('with approval off so the gateway brokers it', chatMcp.tools[0].require_approval, 'never');

check(
  'an MCP case with no server url declares no MCP tool rather than a broken one',
  buildPromptBody('chat.completions', mcpCase, { model: 'm' }).tools,
  undefined,
);

// ── reading the answer back out ─────────────────────────────────────────────

check(
  'chat answer read from choices[0].message.content',
  readAnswerText('chat.completions', { choices: [{ message: { content: 'hello' } }] }),
  'hello',
);
check(
  'responses answer read from output_text when present',
  readAnswerText('responses', { output_text: 'hello' }),
  'hello',
);
check(
  'responses answer assembled from output[] when it is not',
  readAnswerText('responses', {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'hel' }, { text: 'lo' }] }],
  }),
  'hello',
);
check(
  'a tool-call-only response reads as empty text, not a crash',
  readAnswerText('responses', { output: [{ type: 'function_call', name: 'x' }] }),
  '',
);
check('a malformed body reads as empty', readAnswerText('chat.completions', null), '');

// ── evaluating one surface ──────────────────────────────────────────────────

const exchange = (over = {}) => ({
  id: 'x',
  timings: { totalMs: 10 },
  response: { status: 200, headers: {}, body: over.body },
  ...(over.transportError !== undefined ? { transportError: over.transportError } : {}),
  ...(over.status !== undefined
    ? { response: { status: over.status, headers: {}, body: over.body } }
    : {}),
});

const okChat = evaluatePromptOutcome(
  'chat.completions',
  smoke,
  exchange({ body: { choices: [{ message: { content: 'ready' } }] } }),
);
check('a matching answer passes', okChat.ok, true);

const missing = evaluatePromptOutcome(
  'chat.completions',
  smoke,
  exchange({ body: { choices: [{ message: { content: 'nope' } }] } }),
);
check('a missing phrase fails', missing.ok, false);
truthy('and says which phrase', missing.failures.some((f) => f.includes('ready')));

check(
  'a non-200 fails before any content check runs',
  evaluatePromptOutcome('chat.completions', smoke, exchange({ status: 500, body: {} })).failures,
  ['HTTP 500, expected 200'],
);

check(
  'a transport error is reported as transport, not as a content failure',
  evaluatePromptOutcome('chat.completions', smoke, exchange({ transportError: 'ECONNREFUSED' }))
    .failures[0]
    .startsWith('transport:'),
  true,
);

// JSON tolerance: the check is whether JSON is recoverable, not whether the
// model obeyed "no code fence" — that is model behaviour, not the gateway's.
const jsonCase = PROMPT_CASES.find((c) => c.id === 'json-mode');
check(
  'fenced JSON still counts as parseable',
  evaluatePromptOutcome(
    'chat.completions',
    jsonCase,
    exchange({ body: { choices: [{ message: { content: ['```json', '{"city":"Paris"}', '```'].join(String.fromCharCode(10)) } }] } }),
  ).ok,
  true,
);
check(
  'prose is not',
  evaluatePromptOutcome(
    'chat.completions',
    jsonCase,
    exchange({ body: { choices: [{ message: { content: 'The city is Paris.' } }] } }),
  ).ok,
  false,
);

// ── the cross-surface comparison ────────────────────────────────────────────
// Deliberately not string equality: a model is not deterministic, so comparing
// text would report a disagreement every run and the signal would be worthless.

const outcome = (over) => ({
  surface: over.surface,
  exchangeId: 'x',
  status: 200,
  text: over.text ?? '',
  toolCalls: over.toolCalls ?? [],
  brokeredCalls: over.brokeredCalls ?? [],
  offeredTools: over.offeredTools ?? [],
  mcpIssues: over.mcpIssues ?? [],
  failures: over.failures ?? [],
  ok: (over.failures ?? []).length === 0,
  totalMs: 1,
});

check(
  'different wording is NOT a disagreement',
  comparePromptOutcomes([
    outcome({ surface: 'chat.completions', text: 'Ready!' }),
    outcome({ surface: 'responses', text: 'ready' }),
  ]).agrees,
  true,
);

check(
  'a different tool call IS',
  comparePromptOutcomes([
    outcome({ surface: 'chat.completions', text: 'x', toolCalls: [{ name: 'get_weather' }] }),
    outcome({ surface: 'responses', text: 'x', toolCalls: [] }),
  ]).agrees,
  false,
);

check(
  'one surface answering and the other not IS',
  comparePromptOutcomes([
    outcome({ surface: 'chat.completions', text: 'hello' }),
    outcome({ surface: 'responses', text: '   ' }),
  ]).agrees,
  false,
);

check(
  'one surface failing its checks IS',
  comparePromptOutcomes([
    outcome({ surface: 'chat.completions', text: 'x' }),
    outcome({ surface: 'responses', text: 'x', failures: ['answer omits "ready"'] }),
  ]).agrees,
  false,
);

check(
  'tool call ORDER does not matter, only which tools',
  comparePromptOutcomes([
    outcome({ surface: 'chat.completions', text: 'x', toolCalls: [{ name: 'a' }, { name: 'b' }] }),
    outcome({ surface: 'responses', text: 'x', toolCalls: [{ name: 'b' }, { name: 'a' }] }),
  ]).agrees,
  true,
);

check(
  'a single surface cannot disagree with itself',
  comparePromptOutcomes([outcome({ surface: 'chat.completions', text: 'x' })]).agrees,
  true,
);

// A case that does not ask for agreement is not failed by a disagreement.
check(
  'agreement is only enforced when the case asks for it',
  summarisePromptResult(jsonCase, [
    outcome({ surface: 'chat.completions', text: 'x', toolCalls: [{ name: 'a' }] }),
    outcome({ surface: 'responses', text: 'x', toolCalls: [] }),
  ]).ok,
  true,
);
check(
  'and it IS enforced when the case does',
  summarisePromptResult(smoke, [
    outcome({ surface: 'chat.completions', text: 'x', toolCalls: [{ name: 'a' }] }),
    outcome({ surface: 'responses', text: 'x', toolCalls: [] }),
  ]).ok,
  false,
);

// ── cost ceiling ────────────────────────────────────────────────────────────
// Shown before anything is sent, so it has to be right.
check(
  'the estimate counts every case on every surface',
  estimateRun([{ maxTokens: 10 }, { maxTokens: 20 }], ['chat.completions', 'responses']),
  { calls: 4, maxOutputTokens: 60 },
);
check(
  'and halves when one surface is dropped',
  estimateRun([{ maxTokens: 10 }, { maxTokens: 20 }], ['responses']),
  { calls: 2, maxOutputTokens: 30 },
);

// A partial outcome — a field absent despite the type — must not take the whole
// run down with it. These objects arrive as plain JSON over SSE.
check(
  'comparing outcomes with brokeredCalls missing does not throw',
  comparePromptOutcomes([
    { surface: 'chat.completions', text: 'x', toolCalls: [], failures: [], ok: true, exchangeId: 'a', status: 200, totalMs: 1 },
    { surface: 'responses', text: 'x', toolCalls: [], failures: [], ok: true, exchangeId: 'b', status: 200, totalMs: 1 },
  ]).agrees,
  true,
);

done();
