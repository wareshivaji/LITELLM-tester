import { createSuite } from './_harness.mjs';

import { serverSlug, wireNameFor, withWireNames } from '../dist/index.js';

const { check, truthy, done } = createSuite('wire names');

// Transcribed from serverSlug / namespacedName in the gateway's
// internal/mcp/loop.go. Independently confirmed on 2026-09-02: the gateway
// handed `huggingface__hub_repo_search` back to a client in a live response,
// matching what this derives from the server name alone.

check('the live server names slug as measured', [
  serverSlug('HuggingFace'),
  serverSlug('MS Learn'),
  serverSlug('Cloudflare docs'),
], ['huggingface', 'ms_learn', 'cloudflare_docs']);

check(
  'and produce the wire names the gateway actually emitted',
  [
    wireNameFor('HuggingFace', 'hub_repo_search').name,
    wireNameFor('MS Learn', 'microsoft_docs_fetch').name,
    wireNameFor('Cloudflare docs', 'search_cloudflare_documentation').name,
  ],
  [
    'huggingface__hub_repo_search',
    'ms_learn__microsoft_docs_fetch',
    'cloudflare_docs__search_cloudflare_documentation',
  ],
);

// ── the slug rules ──────────────────────────────────────────────────────────

check('a run of separators collapses to one underscore', serverSlug('My   Cool -- Server'), 'my_cool_server');
check('leading and trailing separators are trimmed', serverSlug('  --Books--  '), 'books');
check('case folds down', serverSlug('GitHub'), 'github');
check('digits survive', serverSlug('Server 2'), 'server_2');
check('punctuation becomes a separator', serverSlug("Bob's Tools!"), 'bob_s_tools');
check('a name with nothing usable slugs to empty', serverSlug('!!!'), '');
check('and that is reported rather than guessed', wireNameFor('!!!', 'x').name, undefined);
truthy('with a note saying the gateway falls back to the id', wireNameFor('!!!', 'x').note.includes('id'));

// ── the two cases the gateway disambiguates with a digest we cannot compute ──
// A plausible-looking wrong name is worse than an honest gap: it would be
// pasted into a forced-call test and fail for the wrong reason.

const ambiguous = wireNameFor('HuggingFace', 'search', { slugIsAmbiguous: true });
check('a colliding slug yields no name', ambiguous.name, undefined);
truthy('and says a digest is involved', ambiguous.note.includes('digest'));
check('but the slug itself is still reported', ambiguous.slug, 'huggingface');

const tooLong = wireNameFor('A'.repeat(30), 'b'.repeat(40));
check('a name over 64 characters yields no name', tooLong.name, undefined);
truthy('and says why', tooLong.note.includes('64'));

// Right at the boundary it must still derive.
const at64 = wireNameFor('a'.repeat(10), 'b'.repeat(52));
check('exactly 64 characters is fine', at64.name?.length, 64);

// ── tool-name sanitising ────────────────────────────────────────────────────

check(
  'illegal characters in a tool name become underscores',
  wireNameFor('S', 'get thing!now').name,
  's__get_thing_now',
);
check('hyphens and underscores are legal and kept', wireNameFor('S', 'a-b_c').name, 's__a-b_c');

// ── collision detection across a whole listing ──────────────────────────────
// Whether a name is derivable depends on the OTHER servers present, because the
// gateway only adds its digest when two slugs actually clash.

const listing = withWireNames([
  { name: 'My Server', tools: [{ name: 'a', policy: 'allow' }] },
  { name: 'my-server', tools: [{ name: 'b', policy: 'allow' }] },
  { name: 'Other', tools: [{ name: 'c', policy: 'block' }] },
]);

check('both clashing servers slug the same way', [
  serverSlug('My Server'),
  serverSlug('my-server'),
], ['my_server', 'my_server']);
check('so neither of their tools gets a derived name', [
  listing[0].tools[0].wire.name,
  listing[1].tools[0].wire.name,
], [undefined, undefined]);
check('while the non-colliding server is unaffected', listing[2].tools[0].wire.name, 'other__c');
check('and the policy rides along untouched', listing[2].tools[0].policy, 'block');

check(
  'a single server with a unique slug derives normally',
  withWireNames([{ name: 'Only', tools: [{ name: 'x', policy: 'allow' }] }])[0].tools[0].wire.name,
  'only__x',
);
check('an empty listing is an empty result', withWireNames([]), []);
check(
  'a server with no tools survives',
  withWireNames([{ name: 'Empty', tools: [] }])[0].tools,
  [],
);

// The separator is TokenShield's `__`, not LiteLLM's configurable `-`. A client
// splitting on the LiteLLM form mis-parses every aggregated name.
truthy(
  'the separator is a double underscore',
  wireNameFor('S', 'tool').name.includes('__') && !wireNameFor('S', 'tool').name.includes('-'),
);

done();
