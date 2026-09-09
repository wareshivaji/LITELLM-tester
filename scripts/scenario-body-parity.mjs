/**
 * Byte-compare every scenario request body: TypeScript against Python.
 *
 * `/api/scenarios/run` has no dry-run mode, so unlike `/api/prompts/run` its
 * bodies cannot be gated through `lab diff` without spending. This is the free
 * deterministic equivalent: build all 16 bodies on both sides with the SAME
 * context and compare.
 *
 * It also guards the assumption `engine/scenario_bodies.py` rests on. Those
 * bodies were generated with sentinel context values and are resolved by
 * whole-value substitution, which is only safe while no body interpolates the
 * model inside a longer string. A scenario that did would show up here as a
 * difference rather than as a confusing runtime failure months later.
 *
 *   node scripts/scenario-body-parity.mjs
 *
 * Exit 0 identical, 1 diverged, 2 could not run.
 */
import { execFileSync } from 'node:child_process';
import { SUITES } from '../packages/client/dist/index.js';

// Deliberately not the defaults, and deliberately containing characters a naive
// string substitution would mangle.
const CTX = { model: 'test-model-1.2', embedModel: 'embed-model-3.4' };

const ts = {};
for (const suite of SUITES) {
  for (const sc of suite.scenarios) {
    ts[sc.id] = sc.body === undefined ? null : (sc.body(CTX) ?? null);
  }
}

let py;
try {
  const out = execFileSync(
    'python',
    ['-c', `
import json, sys
sys.path.insert(0, r"../tokenshield-lab-engine")
from engine.scenario_bodies import SCENARIO_BODIES, resolve_body
print(json.dumps({
    sid: resolve_body(sc["body"], "${CTX.model}", "${CTX.embedModel}")
    for sid, sc in SCENARIO_BODIES.items()
}))
`],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
  );
  py = JSON.parse(out);
} catch (error) {
  console.error('scenario-body-parity: could not run the Python side:', error.message);
  process.exit(2);
}

const ids = [...new Set([...Object.keys(ts), ...Object.keys(py)])].sort();
const diffs = [];
for (const id of ids) {
  const a = JSON.stringify(ts[id]);
  const b = JSON.stringify(py[id]);
  if (a !== b) diffs.push({ id, a, b });
}

if (diffs.length === 0) {
  console.log(`scenario-body-parity: identical — ${ids.length} bodies`);
  process.exit(0);
}
console.error(`scenario-body-parity: DIVERGED on ${diffs.length} of ${ids.length}`);
for (const d of diffs) {
  console.error(`  ${d.id}\n    ts: ${d.a}\n    py: ${d.b}`);
}
process.exit(1);
