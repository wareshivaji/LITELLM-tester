import { checkExpectation, evaluateScenario, reportToMarkdown, tally } from '../dist/index.js';
import { createSuite } from './_harness.mjs';

const { check, done } = createSuite('scenarios');

/** A minimal Exchange, only the fields the evaluator reads. */
function exchange({ status = 200, body, bodyText, headers = {}, verdict = 'ok', envelope = 'none', transportError } = {}) {
  const ex = {
    id: 'ex-1',
    profileId: 'p',
    profileLabel: 'P',
    baseUrl: 'https://x',
    keyAlias: 'K',
    authScheme: 'bearer',
    surface: 'chat.completions',
    mode: 'raw',
    request: { method: 'POST', url: 'https://x/v1/chat/completions', path: '/v1/chat/completions', headers: {} },
    timings: { startedAt: '2026-01-01T00:00:00.000Z', ttfbMs: 1, totalMs: 2 },
    gateway: {},
    verdict: { kind: verdict, envelope, detail: '' },
  };
  if (transportError !== undefined) ex.transportError = transportError;
  else ex.response = { status, statusText: '', headers, body, bodyText: bodyText ?? JSON.stringify(body ?? {}) };
  return ex;
}

// ── Expectation matching ─────────────────────────────────────────────────────

check('a met expectation yields no failures', checkExpectation({ status: 200 }, exchange({ status: 200 })), []);
check(
  'status mismatch is reported in words',
  checkExpectation({ status: 404 }, exchange({ status: 200 })),
  ['status 200, expected 404'],
);
check('a list of allowed statuses', checkExpectation({ status: [400, 404] }, exchange({ status: 404 })), []);
check(
  'verdict mismatch',
  checkExpectation({ verdict: 'budget' }, exchange({ verdict: 'ratelimit' })),
  ['verdict ratelimit, expected budget'],
);
check(
  'envelope mismatch',
  checkExpectation({ envelope: 'flat' }, exchange({ envelope: 'openai' })),
  ['envelope openai, expected flat'],
);
check(
  'a required header that is absent',
  checkExpectation({ headers: ['x-request-id'] }, exchange({})),
  ['missing header x-request-id'],
);
check(
  'a required header that is present',
  checkExpectation({ headers: ['x-request-id'] }, exchange({ headers: { 'x-request-id': 'abc' } })),
  [],
);
check(
  'contains is case-insensitive',
  checkExpectation({ contains: 'NO-SUCH-MODEL' }, exchange({ bodyText: 'unknown model: no-such-model' })),
  [],
);

// ── bodyPath, including array indices ────────────────────────────────────────

const chatBody = { choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 9 } };
check(
  'a nested path that exists',
  checkExpectation({ bodyPath: { 'choices.0.message.content': true } }, exchange({ body: chatBody })),
  [],
);
check(
  'a nested path that does not',
  checkExpectation({ bodyPath: { 'choices.0.message.tool_calls': true } }, exchange({ body: chatBody })),
  ['missing choices.0.message.tool_calls'],
);
check(
  'an exact value match',
  checkExpectation({ bodyPath: { 'usage.total_tokens': 9 } }, exchange({ body: chatBody })),
  [],
);
check(
  'an exact value mismatch reports both sides',
  checkExpectation({ bodyPath: { 'usage.total_tokens': 10 } }, exchange({ body: chatBody })),
  ['usage.total_tokens is 9, expected 10'],
);

// ── Landmine semantics: a matching expectation means the bug is STILL THERE ──

const landmine = { id: 'lm', title: 'L', why: '', surface: 's', body: () => ({}), landmine: 'LM-3', spends: false, expect: { status: 400 } };
const normal = { id: 'n', title: 'N', why: '', surface: 's', body: () => ({}), spends: false, expect: { status: 200 } };

check(
  'a normal scenario meeting its expectation passes',
  evaluateScenario(normal, 'suite', exchange({ status: 200 }), 'T').outcome,
  'pass',
);
check(
  'a normal scenario missing it fails',
  evaluateScenario(normal, 'suite', exchange({ status: 500, verdict: 'bad-request' }), 'T').outcome,
  'fail',
);
check(
  'a landmine matching means the defect is still present',
  evaluateScenario(landmine, 'suite', exchange({ status: 400, verdict: 'bad-request' }), 'T').outcome,
  'landmine-present',
);
check(
  'a landmine no longer matching means something moved',
  evaluateScenario(landmine, 'suite', exchange({ status: 200 }), 'T').outcome,
  'landmine-changed',
);

// ── The inconclusive rule: an unreachable target measures nothing ────────────

check(
  'a 401 the scenario did not expect is inconclusive, not a failure',
  evaluateScenario(normal, 'suite', exchange({ status: 401, verdict: 'auth' }), 'T').outcome,
  'inconclusive',
);
check(
  'and a landmine on that target is NOT reported as changed',
  evaluateScenario(landmine, 'suite', exchange({ status: 401, verdict: 'auth' }), 'T').outcome,
  'inconclusive',
);
check(
  'a scenario that EXPECTS auth still passes on a 401',
  evaluateScenario(
    { ...normal, expect: { status: 401, verdict: 'auth' } },
    'suite',
    exchange({ status: 401, verdict: 'auth' }),
    'T',
  ).outcome,
  'pass',
);
check(
  'a transport error is an error, not a failure',
  evaluateScenario(normal, 'suite', exchange({ transportError: 'ECONNREFUSED' }), 'T').outcome,
  'error',
);

// ── Report ───────────────────────────────────────────────────────────────────

const results = [
  evaluateScenario(normal, 's', exchange({ status: 200 }), 'Prod US'),
  evaluateScenario(landmine, 's', exchange({ status: 400, verdict: 'bad-request' }), 'Prod US'),
  evaluateScenario(normal, 's', exchange({ status: 401, verdict: 'auth' }), 'Mumbai'),
];
const counts = tally(results);
check('tally counts each outcome', [counts.pass, counts['landmine-present'], counts.inconclusive], [1, 1, 1]);

const md = reportToMarkdown({
  suiteId: 's',
  suiteTitle: 'Suite',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 10,
  model: 'm',
  embedModel: 'e',
  targets: [{ label: 'Prod US', baseUrl: 'https://x', keyAlias: 'K' }],
  results,
  tally: counts,
});
check('markdown names every target row', md.includes('| Mumbai |'), true);
check('markdown explains what a landmine row means', md.includes('landmine-present'), true);
check('markdown explains inconclusive', md.includes('inconclusive'), true);

done();
