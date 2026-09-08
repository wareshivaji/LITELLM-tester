/**
 * Check `fields.ts` against what LiteLLM actually declares — in-process.
 *
 * Convergence Phase 7.3. `fields.ts` was transcribed BY HAND from LiteLLM's
 * source, and a hand transcription rots silently. This makes it rot loudly:
 * `litellm.get_supported_openai_params` returns LiteLLM's own declaration, so
 * the comparison needs no credential, no proxy and no network.
 *
 * It lives here rather than in the Python suite because `CHAT_FIELDS` must have
 * exactly ONE definition. An earlier version duplicated the list into a pytest
 * file and it was stale within the hour — which is the failure this script
 * exists to catch, so making it the same way would have been funny but not
 * useful.
 *
 * The first run found seven OpenAI chat fields missing from the table, one of
 * them `max_completion_tokens` — OpenAI's replacement for `max_tokens`, which a
 * client on a current SDK sends as a matter of course. Adding them then
 * falsified a `FIELD_GAPS` entry claiming `store` had no chat equivalent, which
 * was wrong and had been framed as a data-residency question.
 *
 *   node scripts/litellm-fields-parity.mjs
 *
 * Exit 0 in sync, 1 drifted, 2 could not run (LiteLLM absent — not a failure).
 */
import { execFileSync } from 'node:child_process';
import { CHAT_FIELDS, FIELD_GAPS, RESPONSES_FIELDS } from '../packages/client/dist/index.js';

const BEDROCK = 'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';
const OPENAI = 'gpt-4o';

/**
 * Listed by LiteLLM but NOT OpenAI request-body fields, so their absence from
 * `fields.ts` is correct rather than a gap. Two kinds: SDK-level options that
 * never go on the wire, and provider extensions. Without this split the
 * comparison reports a dozen false gaps and buries the real ones.
 */
const NOT_REQUEST_FIELDS = new Set([
  'extra_headers',
  'max_retries',
  'thinking',
  'context_management',
  'requestMetadata',
]);

/** Structural rather than optional, so LiteLLM does not list them. */
const STRUCTURAL = new Set(['model', 'messages', 'stream']);

let declared;
try {
  const out = execFileSync(
    'python',
    ['-c', `
import json
import litellm
def s(m):
    return set(litellm.get_supported_openai_params(model=m) or [])
print(json.dumps({
    "version": __import__("importlib.metadata", fromlist=["version"]).version("litellm"),
    "bedrock": sorted(s("${BEDROCK}")),
    "openai": sorted(s("${OPENAI}")),
}))
`],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
  );
  declared = JSON.parse(out);
} catch (error) {
  // Not a failure. LiteLLM is a reference, not a dependency of the lab.
  console.error('litellm-fields-parity: skipped —', (error.message || '').split('\n')[0]);
  process.exit(2);
}

const all = new Set([...declared.bedrock, ...declared.openai]);
const ours = new Set(CHAT_FIELDS);

const missing = [...all].filter((f) => !ours.has(f) && !NOT_REQUEST_FIELDS.has(f) && !STRUCTURAL.has(f)).sort();

// A gap entry must describe a field genuinely absent from the other surface.
// This is the invariant that caught the bogus `store` entry.
const falseGaps = FIELD_GAPS.filter((g) =>
  g.on === 'chat.completions' ? RESPONSES_FIELDS.includes(g.field) : CHAT_FIELDS.includes(g.field),
);

console.log(`litellm ${declared.version} declares ${all.size} params across the two reference models`);
console.log(`  bedrock ${declared.bedrock.length}, openai ${declared.openai.length}`);
console.log(`  fields.ts chat table: ${CHAT_FIELDS.length}`);

let failed = false;
if (missing.length > 0) {
  failed = true;
  console.error(`\nDRIFTED: ${missing.length} OpenAI chat field(s) LiteLLM declares are absent from fields.ts:`);
  console.error(`  ${missing.join(', ')}`);
  console.error('  Add them, with what each does when the gateway ignores it.');
}
if (falseGaps.length > 0) {
  failed = true;
  console.error(`\nDRIFTED: ${falseGaps.length} FIELD_GAPS entr(ies) name a field that exists on BOTH surfaces:`);
  for (const g of falseGaps) console.error(`  ${g.field} (claimed ${g.on}-only)`);
  console.error('  A gap that invents a difference is worse than a missing one.');
}

if (failed) process.exit(1);
console.log('\nin sync — no declared field missing, no gap entry contradicted');
