import { createSuite } from './_harness.mjs';

import {
  buildMcpAuthHeader,
  checkMcpAuthScoping,
  groupMcpAuthHeaders,
  isSecretHeader,
  parseMcpAuthHeader,
  redactHeaders,
} from '../dist/index.js';

const { check, truthy, done } = createSuite('per-server MCP credentials');

// Mined from LiteLLM v1.100.0's
// test_aresponses_api_with_mcp_passes_mcp_server_auth_headers_to_process_tools,
// whose fixture is exactly this header and this parsed result.

check(
  "LiteLLM's own fixture parses to its own expected shape",
  parseMcpAuthHeader('x-mcp-linear_config-authorization'),
  { alias: 'linear_config', header: 'Authorization', ambiguous: false },
);

check(
  'and grouping matches the map they assert on',
  groupMcpAuthHeaders({ 'x-mcp-linear_config-authorization': 'Bearer linear-token' }),
  { linear_config: { Authorization: 'Bearer linear-token' } },
);

check('case is normalised on the way in', parseMcpAuthHeader('X-MCP-Books-AUTHORIZATION').alias, 'books');
check('and the header is title-cased', parseMcpAuthHeader('x-mcp-books-authorization').header, 'Authorization');
check(
  'a multi-word header keeps its internal hyphens, title-cased per part',
  parseMcpAuthHeader('x-mcp-books-x-api-key').header,
  'X-Api-Key',
);

// ── the headers that are NOT per-server credentials ─────────────────────────
// Both of these start with the prefix and neither names a server. Treating
// them as one would invent an alias called `auth` or `servers`.

check('the legacy x-mcp-auth is not a per-server credential', parseMcpAuthHeader('x-mcp-auth'), undefined);
check('nor is the scoping header x-mcp-servers', parseMcpAuthHeader('x-mcp-servers'), undefined);
check('an unrelated header is not one either', parseMcpAuthHeader('authorization'), undefined);
check('nor a bare prefix', parseMcpAuthHeader('x-mcp-'), undefined);
check('nor a trailing separator with no header part', parseMcpAuthHeader('x-mcp-books-'), undefined);

check(
  'and none of them appear in a grouping',
  groupMcpAuthHeaders({
    'x-mcp-auth': 'legacy',
    'x-mcp-servers': 'books,docs',
    authorization: 'Bearer gateway-key',
    'content-type': 'application/json',
  }),
  {},
);

// ── the hyphen trap ─────────────────────────────────────────────────────────
// The alias and the header are split on the FIRST hyphen after the prefix, so a
// hyphenated alias silently becomes a different server. LiteLLM's own example
// alias uses an underscore for this reason.

const trap = parseMcpAuthHeader('x-mcp-linear-config-authorization');
check('a hyphenated alias splits at the wrong place', trap.alias, 'linear');
check('and the rest lands in the header name', trap.header, 'Config-Authorization');
truthy('so the split is flagged ambiguous rather than trusted', trap.ambiguous);

// Building refuses to emit a header that will be mis-parsed. A credential
// silently routed to a server that does not exist is worse than a loud failure.
check('building a safe alias works', buildMcpAuthHeader('linear_config'), 'x-mcp-linear_config-authorization');
check('the header name defaults to authorization', buildMcpAuthHeader('books'), 'x-mcp-books-authorization');
check('and can be overridden', buildMcpAuthHeader('books', 'X-Api-Key'), 'x-mcp-books-x-api-key');

let threw = false;
try {
  buildMcpAuthHeader('linear-config');
} catch (err) {
  threw = true;
  truthy('the error names the separator problem', String(err).includes('separator'));
  truthy('and suggests the fix', String(err).includes('underscore'));
}
truthy('a hyphenated alias is refused, not silently emitted', threw);

// ── scoping: server A must never hold server B's token ──────────────────────

const twoServers = {
  'x-mcp-books-authorization': 'Bearer books-token',
  'x-mcp-docs-authorization': 'Bearer docs-token',
};

check('both aliases are seen', checkMcpAuthScoping(twoServers, 'books').aliases, ['books', 'docs']);
check(
  'and the one that should not be here is named',
  checkMcpAuthScoping(twoServers, 'books').unexpected,
  ['docs'],
);
check(
  'a correctly scoped credential reports nothing unexpected',
  checkMcpAuthScoping({ 'x-mcp-books-authorization': 'Bearer t' }, 'books').unexpected,
  [],
);
check(
  'the expected alias is matched case-insensitively',
  checkMcpAuthScoping({ 'x-mcp-books-authorization': 'Bearer t' }, 'BOOKS').unexpected,
  [],
);
check(
  'an ambiguous header is surfaced by the scoping check too',
  checkMcpAuthScoping({ 'x-mcp-my-server-authorization': 'Bearer t' }, 'my_server').ambiguous,
  ['my'],
);

// ── these are credentials, so they must never be recorded in the clear ──────

truthy('every per-server credential header is a secret', isSecretHeader('x-mcp-books-authorization'));
truthy('including the legacy one', isSecretHeader('x-mcp-auth'));
check(
  'and redaction masks the value while keeping the scheme',
  redactHeaders({ 'x-mcp-books-authorization': 'Bearer books-secret-token-value' })[
    'x-mcp-books-authorization'
  ].includes('books-secret'),
  false,
);

done();
