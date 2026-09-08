/**
 * Dump every scenario's request body and expectation as data.
 *
 * The bodies are `(ctx) => ({...})` closures, so they cannot cross into Python
 * as code. They are invoked here with SENTINEL values for the two context
 * fields and dumped as JSON; the Python side substitutes the real model at
 * build time. Verified safe first: `ctx.model` is used five times and
 * `ctx.embedModel` never, and neither is ever interpolated inside a longer
 * string, so a whole-value substitution cannot corrupt anything.
 *
 * Generated rather than hand-transcribed for the same reason as
 * `engine/cases.py`: retyping 17 bodies by hand would differ from the original
 * in small ways the migration gate would surface one at a time, whereas taking
 * the real output makes parity true by construction.
 *
 *   node scripts/gen-scenario-bodies.mjs > testdata/scenario-bodies.json
 */
import { SUITES } from '../packages/client/dist/index.js';

const CTX = { model: '__MODEL__', embedModel: '__EMBED_MODEL__' };

const out = SUITES.map((suite) => ({
  id: suite.id,
  scenarios: suite.scenarios.map((sc) => {
    const entry = {
      id: sc.id,
      surface: sc.surface,
      spends: sc.spends,
      expect: sc.expect,
      body: sc.body === undefined ? null : (sc.body(CTX) ?? null),
    };
    // Only present on some scenarios; absent is meaningful, so it is omitted
    // rather than nulled.
    if (sc.unauthenticated !== undefined) entry.unauthenticated = sc.unauthenticated;
    if (sc.landmine !== undefined) entry.landmine = sc.landmine;
    if (sc.notImplemented !== undefined) entry.notImplemented = sc.notImplemented;
    if (sc.reference !== undefined) entry.reference = sc.reference;
    return entry;
  }),
}));

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
