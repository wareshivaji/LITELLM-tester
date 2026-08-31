import { isSecretHeader, maskSecret, redactHeaders, scrubText } from '../dist/index.js';
import { createSuite } from './_harness.mjs';

const { check, done } = createSuite('redaction');

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

done();
