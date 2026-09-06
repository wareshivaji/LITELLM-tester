/**
 * Generate golden files from the TypeScript implementation, for the Go port to
 * be checked against.
 *
 * The TypeScript is the incumbent: 340 passing tests, live-verified against a
 * real gateway. So it is the oracle, and the Go port is not trusted because it
 * looks right — it is trusted because it produces byte-identical answers to the
 * same inputs. A port that compiles and disagrees is worse than no port,
 * because it looks finished.
 *
 * Inputs are checked in and hand-written to cover the contract, not generated:
 * a randomly generated corpus would mostly exercise the boring branches and
 * miss the two 429s and the guardrail-is-400, which are the whole point.
 *
 *   node scripts/gen-golden.mjs          # write the goldens
 *   node scripts/gen-golden.mjs --check  # fail if they are stale
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  detectEnvelope,
  normalizeError,
  serverSlug,
  SSEParser,
  wireNameFor,
} from '../packages/client/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const inputsDir = resolve(root, 'testdata');
const goldenDir = resolve(root, 'go/internal/contract/testdata');

const check = process.argv.includes('--check');

function load(name) {
  return JSON.parse(readFileSync(resolve(inputsDir, name), 'utf8'));
}

// ── classify ────────────────────────────────────────────────────────────────

const classifyCases = load('classify-cases.json');
const classifyGolden = classifyCases.map((c) => {
  const input = {
    status: c.status,
    headers: c.headers ?? {},
    body: c.body,
    ...(c.transportError !== undefined ? { transportError: c.transportError } : {}),
  };
  const verdict = classify(input);
  return {
    name: c.name,
    // The envelope and the normalised error are emitted separately as well as
    // inside the verdict: they are independently exported functions, and a port
    // could get the verdict right while getting the envelope wrong.
    envelope: detectEnvelope(c.body),
    error: normalizeError(c.body),
    verdict: { kind: verdict.kind, detail: verdict.detail, envelope: verdict.envelope },
  };
});

// ── wire names ──────────────────────────────────────────────────────────────

const wireCases = load('wire-cases.json');
const wireGolden = wireCases.map((c) => ({
  name: c.name,
  slug: serverSlug(c.serverName),
  wire: wireNameFor(c.serverName, c.toolName, { slugIsAmbiguous: c.slugIsAmbiguous === true }),
}));

// ── SSE ─────────────────────────────────────────────────────────────────────
// Text pushes rather than bytes: the multi-byte-split case is covered by a
// dedicated Go test, because expressing raw bytes in a JSON fixture would make
// the fixture unreadable for no gain.

const sseCases = load('sse-cases.json');
const sseGolden = sseCases.map((c) => {
  const parser = new SSEParser();
  const frames = [];
  let t = 0;
  for (const push of c.pushes) {
    t += 10;
    frames.push(...parser.pushText(push, t));
  }
  frames.push(...parser.flush(t + 10));
  return { name: c.name, frames };
});

// ── write or compare ────────────────────────────────────────────────────────

const outputs = [
  ['classify-golden.json', classifyGolden],
  ['wire-golden.json', wireGolden],
  ['sse-golden.json', sseGolden],
];

let stale = 0;
mkdirSync(goldenDir, { recursive: true });
for (const [name, value] of outputs) {
  const path = resolve(goldenDir, name);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      console.error(`STALE: ${name} — regenerate with \`node scripts/gen-golden.mjs\``);
      stale += 1;
    } else {
      console.log(`ok: ${name} (${value.length} cases)`);
    }
  } else {
    writeFileSync(path, next);
    console.log(`wrote ${name} (${value.length} cases)`);
  }
}

if (check && stale > 0) process.exit(1);
