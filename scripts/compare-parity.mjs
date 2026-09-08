/**
 * The gate for `/api/compare`, the one endpoint `lab diff` cannot cover.
 *
 * `lab diff` needs both backends running, and this endpoint is the reason the
 * Node backend is being retired: after Phase 8.1b there is no Node
 * `/api/compare` to compare against, because Python's version IS the one that
 * spawns what is left of Node. So the reference is recorded instead, in
 * `testdata/compare-reference.json`, captured from Node before the change.
 *
 * Same approach as `sse-parity.mjs`: when a live comparison is impossible, the
 * reference becomes a committed fixture. The difference is what can be
 * compared. The SSE parser is deterministic, so that check is byte-exact. This
 * one drives a real SDK against a real gateway, so ids, timings and timestamps
 * differ on every run and a byte comparison would be theatre. It compares
 * STRUCTURE — which is the same choice made for `tools/loop` in Phase 4b.
 *
 * ## The fixture costs nothing to reproduce
 *
 * Every case runs on the `INVALID_ON_PURPOSE` alias, so the gateway answers 401
 * and no tokens are spent. That is not a compromise for cost: a 401 through a
 * real SDK is the most informative case this surface has, because the question
 * it answers is what a customer's `catch` block receives, and the gateway's
 * flat `{"error":"string"}` envelope is not something an OpenAI SDK can parse.
 * A successful 200 would exercise less of the interesting path.
 *
 * The alias is itself a dummy (`cg-ak-0000…`), which is why the fixture is safe
 * to commit — masked or not, there is nothing in it to leak.
 *
 * Usage: node scripts/compare-parity.mjs   (with the Python engine on :8801)
 */
import { readFileSync } from 'node:fs';

const ENGINE = process.env.TSLAB_ENGINE ?? 'http://127.0.0.1:8801';
const REFERENCE = new URL('../testdata/compare-reference.json', import.meta.url);

/**
 * The fields that must agree.
 *
 * Everything absent from this list is either volatile (ids, timings,
 * timestamps) or model output. Listing what IS compared, rather than excluding
 * what is not, means a new field added to the payload is silently ignored
 * rather than silently failing — the safe direction for a gate whose job is to
 * catch a port that got the SHAPE wrong.
 */
function shapeOf(payload) {
  if (payload === null || typeof payload !== 'object') return payload;
  if (typeof payload.error === 'string') return { error: payload.error };

  return {
    surfaceId: payload.surfaceId,
    outcomes: (payload.outcomes ?? []).map((o) => ({
      mode: o.mode,
      ok: o.ok,
      // The SDK's error class is the entire point of this surface: it is what
      // the developer's catch block actually receives.
      failure:
        o.failure === undefined
          ? undefined
          : {
              name: o.failure.name,
              status: o.failure.status,
              type: o.failure.type,
              code: o.failure.code,
              typed: o.failure.typed,
            },
      // Plural because both SDKs retry on their own schedule, and each retry is
      // a request the gateway bills for.
      attemptCount: (o.attempts ?? []).length,
      attempts: (o.attempts ?? []).map((a) => ({
        surface: a.surface,
        mode: a.mode,
        method: a.request?.method,
        path: a.request?.path,
        // Names only. The values are masked, and comparing masked values would
        // compare the masker rather than the port.
        requestHeaderNames: Object.keys(a.request?.headers ?? {}).sort(),
        status: a.response?.status,
        verdictKind: a.verdict?.kind,
        verdictEnvelope: a.verdict?.envelope,
        verdictCode: a.verdict?.code,
        verdictType: a.verdict?.type,
        hasTransportError: a.transportError !== undefined,
        authScheme: a.authScheme,
        keyAlias: a.keyAlias,
      })),
      sdkHeaders: o.sdkHeaders ?? [],
    })),
  };
}

const cases = JSON.parse(readFileSync(REFERENCE, 'utf8'));
let differ = 0;

for (const c of cases) {
  const res = await fetch(`${ENGINE}/api/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c.request),
  });
  const body = await res.json().catch(() => ({ _unparseable: true }));

  const want = { status: c.status, shape: shapeOf(c.response) };
  const got = { status: res.status, shape: shapeOf(body) };
  const wantText = JSON.stringify(want, null, 2);
  const gotText = JSON.stringify(got, null, 2);

  if (wantText === gotText) {
    console.log(`  same    ${c.name}`);
    continue;
  }
  differ += 1;
  console.log(`  DIFFER  ${c.name}`);
  const a = wantText.split('\n');
  const b = gotText.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      console.log(`            node   ${a[i] ?? '(absent)'}`);
      console.log(`            python ${b[i] ?? '(absent)'}`);
    }
  }
}

console.log('');
if (differ === 0) {
  console.log(`compare-parity: identical — ${cases.length} cases, structure matched`);
} else {
  console.log(`compare-parity: ${differ} of ${cases.length} cases differ`);
  process.exitCode = 1;
}
