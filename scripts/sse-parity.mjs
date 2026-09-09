/**
 * Byte-compare the TypeScript SSE parser against the Python one.
 *
 * The Phase 5a migration gate. A streaming call to a real gateway is
 * non-deterministic, so gating on live output would be theatre; a RECORDED
 * fixture pushed through both parsers with identical read boundaries is
 * deterministic and tests the thing that can actually diverge.
 *
 * The fixture exercises every branch that has ever gone wrong: a frame split
 * mid-JSON, a multi-byte character split across two reads (the one that bit the
 * Go port), CRLF terminators, an `event:` field, multi-line `data:`, a comment,
 * malformed JSON, the [DONE] sentinel, and a trailing partial frame.
 *
 *   node scripts/sse-parity.mjs
 *
 * Exit 0 identical, 1 diverged, 2 could not run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SSEParser } from '../packages/client/dist/index.js';

const FIXTURE = new URL('../testdata/sse/fixture.json', import.meta.url);
const reads = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const parser = new SSEParser();
const ts = [];
reads.forEach((bytes, i) => {
  for (const f of parser.push(new Uint8Array(bytes), i)) ts.push(f);
});
for (const f of parser.flush(reads.length)) ts.push(f);

let py;
try {
  const out = execFileSync(
    'python',
    ['-c', `
import json, sys
sys.path.insert(0, r"../tokenshield-lab-engine")
from engine.sse import SSEParser
reads = [bytes(r) for r in json.load(open(r"testdata/sse/fixture.json", encoding="utf-8"))]
p = SSEParser(); frames = []
for i, r in enumerate(reads): frames.extend(p.push(r, i))
frames.extend(p.flush(len(reads)))
print(json.dumps(frames))
`],
    { encoding: 'utf8', cwd: new URL('..', import.meta.url) },
  );
  py = JSON.parse(out);
} catch (error) {
  console.error('sse-parity: could not run the Python parser:', error.message);
  process.exit(2);
}

const a = JSON.stringify(ts);
const b = JSON.stringify(py);
if (a === b) {
  console.log(`sse-parity: identical — ${ts.length} frames from ${reads.length} reads`);
  process.exit(0);
}
console.error(`sse-parity: DIVERGED (ts ${ts.length} frames, py ${py.length})`);
for (let i = 0; i < Math.max(ts.length, py.length); i++) {
  const x = JSON.stringify(ts[i]);
  const y = JSON.stringify(py[i]);
  if (x !== y) console.error(`  frame ${i}\n    ts: ${x}\n    py: ${y}`);
}
process.exit(1);
