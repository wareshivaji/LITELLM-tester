/**
 * The JS-SDK probe. One request through a real vendor SDK, recorded.
 *
 * This is what remains of the Node backend after Convergence Phase 8. Every
 * other endpoint moved to the Python engine; this one cannot, and D-6 keeps it
 * permanently rather than as a deferral. The reason is not that porting it is
 * hard — it is that `openai` and `@anthropic-ai/sdk` are *npm packages*, and
 * the question this surface answers is "what does a customer's SDK do when it
 * talks to TokenShield". A Python reimplementation of the OpenAI SDK's retry
 * schedule and error classification would answer a different question: what our
 * reimplementation does. Customers use both the JS and Python SDKs, so this is
 * coverage, not duplication.
 *
 * ## The boundary (D-7)
 *
 * A CLI, not a server. It reads one job from **stdin**, performs it, writes one
 * JSON record to **stdout**, and exits. The engine spawns it per call.
 *
 * stdin rather than argv, deliberately: a credential in argv is visible to
 * every process on the machine through `ps` / Task Manager, and would be
 * captured by any shell history or process accounting in between. stdin is a
 * pipe between two processes that already share a trust boundary.
 *
 * What crosses back is a `ProbeAttempt` per HTTP attempt — what was sent, what
 * came back, how long it took — with credential headers **already masked**, by
 * the same `redactHeaders` the browser bundle uses. The engine turns those into
 * Exchanges: it classifies the verdict, parses the gateway signal and redacts
 * the bodies. Those three things exist exactly once, in Python.
 *
 * ## Why it does not keep the old stack
 *
 * Until 2026-09-08 this ran through `Transport.sendRaw`, which returned a
 * finished Exchange. Convenient, and it dragged 1,439 lines of transport,
 * classify and signal along with it — every one of which Python also owns. Two
 * implementations of "what does this response mean" kept honest by comparing
 * their output is exactly the mistake that cost 1,826 lines in the aborted Go
 * migration. See `docs/CONVERGENCE.md`, D-7 and AD-32.
 *
 * ## Protocol
 *
 * In, on stdin, one JSON object:
 *
 *     {
 *       "mode":       "openai-sdk" | "anthropic-sdk",
 *       "surfaceId":  "chat.completions",
 *       "baseUrl":    "https://gateway.cloudgov.ai",
 *       "secret":     "<the api key>" | null,
 *       "body":       { ... the request, verbatim and unvalidated ... },
 *       "maxRetries": 0,
 *       "timeoutMs":  60000
 *     }
 *
 * Out, on stdout, one JSON object: a `ProbeOutcome`, or `{"probeError": "..."}`
 * if the job itself could not be run.
 *
 * `body` is passed to the SDK unvalidated on purpose. Sending a malformed
 * request through a real SDK is a large part of what this surface is for, and a
 * validator here would reject the interesting cases before they were asked.
 *
 * EXIT CODE. Zero whenever a verdict was reached, INCLUDING when the SDK threw:
 * an SDK error is the observation, not a failure of the probe. Non-zero only
 * when the job could not be attempted — unreadable stdin, malformed job, an
 * unknown mode. The engine distinguishes the two by exit code, so a gateway 500
 * is never reported as a broken lab.
 */

import { runWithSdk } from '@tokenshield/client';
import type { ProbeOutcome, SdkMode } from '@tokenshield/client';

/** The modes this probe can run. `raw` is the engine's own client, not ours. */
const SDK_MODES = new Set<string>(['openai-sdk', 'anthropic-sdk']);

interface Job {
  mode: string;
  surfaceId: string;
  baseUrl: string;
  secret: string | null;
  body: unknown;
  maxRetries?: number;
  timeoutMs?: number;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Validates the job envelope and nothing inside `body`.
 *
 * Returns a message rather than throwing, so every rejection reaches stdout as
 * JSON. A probe that dies with a stack trace on stderr gives the engine
 * nothing to report, and "the lab broke" then gets recorded as a gateway
 * finding.
 */
function readJob(raw: string): { job: Job } | { error: string } {
  if (raw.trim() === '') return { error: 'No job on stdin' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `Job is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'Job is not an object' };
  }

  const j = parsed as Record<string, unknown>;
  if (typeof j['mode'] !== 'string' || !SDK_MODES.has(j['mode'])) {
    return {
      error:
        `mode must be one of ${[...SDK_MODES].join(', ')}` +
        (j['mode'] === 'raw' ? ' — "raw" is the engine\'s own client, not this probe' : ''),
    };
  }
  if (typeof j['surfaceId'] !== 'string' || j['surfaceId'] === '') {
    return { error: 'surfaceId is required' };
  }
  if (typeof j['baseUrl'] !== 'string' || j['baseUrl'] === '') {
    return { error: 'baseUrl is required' };
  }

  return {
    job: {
      mode: j['mode'],
      surfaceId: j['surfaceId'],
      baseUrl: j['baseUrl'],
      secret: typeof j['secret'] === 'string' ? j['secret'] : null,
      body: j['body'],
      ...(typeof j['maxRetries'] === 'number' ? { maxRetries: j['maxRetries'] } : {}),
      ...(typeof j['timeoutMs'] === 'number' ? { timeoutMs: j['timeoutMs'] } : {}),
    },
  };
}

async function main(): Promise<number> {
  const read = readJob(await readStdin());
  if ('error' in read) {
    process.stdout.write(JSON.stringify({ probeError: read.error }) + '\n');
    return 2;
  }
  const { job } = read;

  const outcome: ProbeOutcome = await runWithSdk(
    job.mode as Exclude<SdkMode, 'raw'>,
    job.surfaceId,
    job.body,
    {
      baseUrl: job.baseUrl,
      secret: job.secret,
      ...(job.maxRetries !== undefined ? { maxRetries: job.maxRetries } : {}),
      ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
    },
  );

  process.stdout.write(JSON.stringify(outcome) + '\n');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Only reached if runWithSdk itself threw, which it is written not to do —
    // it catches SDK errors and reports them as an outcome. So this is a bug in
    // the probe, and it says so rather than looking like a gateway result.
    process.stdout.write(
      JSON.stringify({
        probeError: `probe crashed: ${error instanceof Error ? error.message : String(error)}`,
      }) + '\n',
    );
    process.exitCode = 3;
  });
