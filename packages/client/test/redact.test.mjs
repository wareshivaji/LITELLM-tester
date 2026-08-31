import { isSecretBodyKey, isSecretHeader, maskSecret, redactBody, redactHeaders, scrubText, summariseCredentialExposure } from '../dist/index.js';
import { createSuite } from './_harness.mjs';

const { check, truthy, done } = createSuite('redaction');

// An obviously-fake fixture of the right shape. A real key must never be a
// test fixture: the test file is committed, and BP-500 is not negotiable.
const KEY = 'cg-ak-FAKEfakeFAKEfake0000000000000000000000000000000000000000ABCD';

// ── Masking ──────────────────────────────────────────────────────────────────

check('recognisable but unusable', maskSecret(KEY), 'cg-ak-FAKE…ABCD');
check('a short value collapses entirely', maskSecret('abc'), '***');
check(
  'a 12-char value still collapses — no usable fragment',
  maskSecret('123456789012'),
  '************',
);
check('null is empty, not "null"', maskSecret(null), '');
check('undefined is empty', maskSecret(undefined), '');
check('whitespace is trimmed before masking', maskSecret('  ' + KEY + '  '), 'cg-ak-FAKE…ABCD');

// ── Which headers carry a credential ─────────────────────────────────────────

check('authorization', isSecretHeader('Authorization'), true);
check('x-api-key, case-insensitively', isSecretHeader('X-API-Key'), true);
check('x-management-key', isSecretHeader('x-management-key'), true);
check('every x-mcp-* header', isSecretHeader('x-mcp-deep-wiki-authorization'), true);
check('content-type is not a secret', isSecretHeader('content-type'), false);

// ── Header redaction ─────────────────────────────────────────────────────────

const redacted = redactHeaders({
  Authorization: `Bearer ${KEY}`,
  'x-api-key': KEY,
  'Content-Type': 'application/json',
  'x-mcp-authorization': `Bearer ${KEY}`,
});

check('the Bearer scheme survives, the secret does not', redacted['Authorization'], 'Bearer cg-ak-FAKE…ABCD');
check('a bare header value is masked', redacted['x-api-key'], 'cg-ak-FAKE…ABCD');
check('non-secret headers pass through untouched', redacted['Content-Type'], 'application/json');
check('per-server MCP credentials are masked too', redacted['x-mcp-authorization'], 'Bearer cg-ak-FAKE…ABCD');

check(
  'no full-length key survives redaction',
  /cg-ak-[A-Za-z0-9_-]{25,}/.test(JSON.stringify(redacted)),
  false,
);

check(
  'the input object is not mutated',
  (() => {
    const input = { Authorization: `Bearer ${KEY}` };
    redactHeaders(input);
    return input['Authorization'];
  })(),
  `Bearer ${KEY}`,
);

// ── Scrubbing free text — the last line of defence ───────────────────────────

check(
  'a key echoed in a body is scrubbed',
  scrubText(`{"error":"bad key ${KEY}"}`, [KEY]),
  '{"error":"bad key cg-ak-FAKE…ABCD"}',
);
check(
  'every occurrence, not just the first',
  scrubText(`${KEY} and again ${KEY}`, [KEY]).includes(KEY),
  false,
);
check('text with no secret is unchanged', scrubText('nothing here', [KEY]), 'nothing here');
check(
  'a too-short "secret" is ignored rather than mangling the text',
  scrubText('the quick brown fox', ['fox']),
  'the quick brown fox',
);

// ── body-level redaction ────────────────────────────────────────────────────
// The gap this closes: OpenAI's `type:'mcp'` tool block carries a `headers`
// object aimed at a third-party server, so client-supplied credentials sit in
// the request BODY where redactHeaders never looks. That body was recorded
// verbatim and then shown in the exchange log, in copy-as-curl, and in reports.

const mcpToolBody = {
  model: 'bedrock-nova-micro',
  tools: [
    {
      type: 'mcp',
      server_label: 'books',
      server_url: 'https://example.test/mcp',
      headers: { authorization: 'Bearer cg-ak-REALLOOKINGSECRETVALUE1234', 'x-mcp-token': 'abcdefghijklmnop' },
    },
  ],
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
};

const redactedMcp = redactBody(mcpToolBody);

truthy(
  'an authorization nested in an MCP tool declaration is masked',
  !JSON.stringify(redactedMcp).includes('REALLOOKINGSECRETVALUE1234'),
);

truthy(
  'an x-mcp-* credential in the same block is masked',
  !JSON.stringify(redactedMcp).includes('abcdefghijklmnop'),
);

check(
  'the surrounding declaration survives intact — only the credential goes',
  redactedMcp.tools[0].server_url,
  'https://example.test/mcp',
);

check(
  'and the prompt is untouched',
  redactedMcp.input[0].content[0].text,
  'hi',
);

// The important one. If redaction mutated the caller's object, the lab would
// send a masked credential to the gateway and then report on a request nobody
// made.
check(
  'redactBody never mutates its input',
  mcpToolBody.tools[0].headers.authorization,
  'Bearer cg-ak-REALLOOKINGSECRETVALUE1234',
);

// A JSON Schema may legitimately have a property named `token`, whose value is
// an object describing a field rather than a credential. Masking it would
// corrupt the recorded schema for no safety gain.
const schemaBody = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'auth',
        parameters: { type: 'object', properties: { token: { type: 'string' }, password: { type: 'string' } } },
      },
    },
  ],
};
check(
  'an object under a secret-looking key is recursed into, not flattened',
  redactBody(schemaBody).tools[0].function.parameters.properties.token.type,
  'string',
);

check(
  'a string value under the same key IS masked',
  redactBody({ token: 'sk-supersecretvalue123456' }).token.includes('supersecret'),
  false,
);

// A body credential must reveal NOTHING of itself. maskSecret keeps the first
// ten characters, which is safe for cg-ak-* where that prefix is public and a
// disclosure for anything else: a 14-char password came back as
// `hunter2hun…ter2`. Caught by the array test below, which is why it is here.
check(
  'no fragment of a body credential survives, however short',
  redactBody({ password: 'hunter2hunter2' }).password,
  '************',
);

check(
  'the auth scheme is kept — Bearer vs Basic is a debugging signal, not a secret',
  redactBody({ authorization: 'Bearer cg-ak-abcdefghijklmnop' }).authorization,
  'Bearer ************',
);

truthy(
  'and no part of the key itself remains',
  !redactBody({ authorization: 'Bearer cg-ak-abcdefghijklmnop' }).authorization.includes('cg-ak-'),
);

// Fixed width, not the value's length: a 14-character password that masked to
// 14 asterisks would still say "this secret is short".
check(
  'the mask width is fixed, so it discloses nothing about length',
  [
    redactBody({ api_key: 'x'.repeat(400) }).api_key,
    redactBody({ api_key: 'short' }).api_key,
  ],
  ['************', '************'],
);

truthy('nested arrays are walked', Array.isArray(redactBody({ a: [{ password: 'hunter2hunter2' }] }).a));
check(
  'and a credential inside an array element is masked',
  redactBody({ a: [{ password: 'hunter2hunter2' }] }).a[0].password.includes('hunter2'),
  false,
);

check('primitives pass through', redactBody(42), 42);
check('null passes through', redactBody(null), null);
check('a bare string is not a body key, so it is untouched', redactBody('authorization'), 'authorization');

truthy('isSecretBodyKey covers header names too', isSecretBodyKey('x-mcp-authorization'));
truthy('and body-only names', isSecretBodyKey('client_secret'));
check('but not ordinary fields', isSecretBodyKey('max_tokens'), false);
check('nor a similarly-spelled field', isSecretBodyKey('max_completion_tokens'), false);

// ── credential exposure at a third party ────────────────────────────────────
// LiteLLM's troubleshooting guide warns that a proxy can forward its OWN api
// key to an MCP server instead of a scoped token. The lab's mock MCP server
// answers that question, and this is the logic behind the answer.

const leaked = summariseCredentialExposure({
  authorization: 'Bearer cg-ak-SOMEKEYVALUE0123456789',
  'x-mcp-books-authorization': 'Bearer scoped-token-fine',
  'content-type': 'application/json',
});

check('a gateway key reaching a third party is detected', leaked.gatewayKeyLeaked, true);
check('and the header it arrived in is named', leaked.leakedVia, ['authorization']);
check(
  'credential-bearing headers are listed, ordinary ones are not',
  leaked.credentialHeaders,
  ['authorization', 'x-mcp-books-authorization'],
);

// The point of the whole design: report the finding, never the value.
truthy(
  'no part of the key appears in the result',
  !JSON.stringify(leaked).includes('SOMEKEYVALUE'),
);

check(
  'a scoped token that is not a gateway key is NOT reported as a leak',
  summariseCredentialExposure({ 'x-mcp-books-authorization': 'Bearer opaque-third-party' })
    .gatewayKeyLeaked,
  false,
);

// Shape check, not a value comparison — so it catches a key the lab has never
// been told about, which is the only way this is useful in the field.
check(
  'a management key is caught too',
  summariseCredentialExposure({ 'x-api-key': 'cg-mk-NEVERSEENBEFORE123' }).gatewayKeyLeaked,
  true,
);

check(
  'a key hiding in a non-credential header is still caught',
  summariseCredentialExposure({ 'x-custom-debug': 'token=cg-ak-SNEAKY123456' }).leakedVia,
  ['x-custom-debug'],
);

check(
  'nothing to report on a clean request',
  summariseCredentialExposure({ 'content-type': 'application/json' }),
  { credentialHeaders: [], gatewayKeyLeaked: false, leakedVia: [] },
);

done();
