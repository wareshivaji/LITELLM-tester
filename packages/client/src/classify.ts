/**
 * Turns an opaque failure into a named cause.
 *
 * Everything in here is grounded in the gateway's actual code, because the
 * status code alone is ambiguous in ways that have cost real debugging time:
 *
 *  - TWO different 429s. `insufficient_quota` + `budget_name` is a spend cap;
 *    a flat `{"error":"rate limit exceeded","retry_after_seconds":N}` is the
 *    per-minute RPM limiter (default 60). Neither is a bug, and treating them
 *    as one thing makes a scenario run unreadable.
 *  - TWO different 403s. `no_credential_for_provider` means the key has no
 *    credential mapped for that provider; `model_not_allowed_for_key` is the
 *    allowedModels gate, rejected *before* any provider call.
 *  - A guardrail block is a **400**, not a 403, and it carries a flat
 *    non-OpenAI envelope (internal/guardrail/middleware.go). Without the
 *    marker it is indistinguishable from a malformed request.
 *
 * The envelope shape is recorded separately from the verdict, because "which
 * error shape came back" is itself a compatibility finding.
 */

import type { ErrorEnvelope, Verdict, VerdictKind } from './types.js';

interface NormalizedError {
  envelope: ErrorEnvelope;
  message: string;
  code?: string;
  type?: string;
  budgetName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Which error envelope the gateway used.
 *
 * - `openai`    — `{"error":{message,type,param,code}}` (apierror.Send)
 * - `anthropic` — `{"type":"error","error":{type,message}}` on /v1/messages*
 * - `flat`      — `{"error":"some string", ...}` — the legacy shape OpenAI SDKs
 *                 cannot parse. Guardrail blocks and the RPM limiter use it.
 */
export function detectEnvelope(body: unknown): ErrorEnvelope {
  if (!isRecord(body)) return 'none';
  const err = body['error'];
  if (isRecord(err)) {
    return body['type'] === 'error' ? 'anthropic' : 'openai';
  }
  if (typeof err === 'string') return 'flat';
  return 'none';
}

/** Pulls message/code/type out of whichever envelope was used. */
export function normalizeError(body: unknown): NormalizedError {
  const envelope = detectEnvelope(body);
  if (!isRecord(body)) return { envelope, message: '' };

  if (envelope === 'openai' || envelope === 'anthropic') {
    const err = body['error'];
    if (!isRecord(err)) return { envelope, message: '' };
    const result: NormalizedError = { envelope, message: asString(err['message']) ?? '' };
    const code = asString(err['code']);
    const type = asString(err['type']);
    const budgetName = asString(err['budget_name']);
    if (code !== undefined) result.code = code;
    if (type !== undefined) result.type = type;
    if (budgetName !== undefined) result.budgetName = budgetName;
    return result;
  }

  if (envelope === 'flat') {
    const result: NormalizedError = {
      envelope,
      message: asString(body['message']) ?? asString(body['error']) ?? '',
    };
    // In the flat shape the machine-readable token lives in `error` itself
    // (e.g. "guardrail_violation"), so it maps to `code`, not `message`.
    const code = asString(body['error']);
    const budgetName = asString(body['budget_name']);
    if (code !== undefined) result.code = code;
    if (budgetName !== undefined) result.budgetName = budgetName;
    return result;
  }

  return { envelope, message: '' };
}

export interface ClassifyInput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  transportError?: string | undefined;
}

const KIND_LABEL: Record<VerdictKind, string> = {
  ok: 'OK',
  auth: 'Authentication',
  'model-denied': 'Model not allowed for key',
  'no-credential': 'No credential for provider',
  budget: 'Budget cap',
  ratelimit: 'Rate limit (RPM)',
  guardrail: 'Guardrail block',
  'ip-blocked': 'IP allowlist',
  'tool-policy': 'Tool policy',
  'not-found': 'Not found',
  'bad-request': 'Bad request',
  'server-error': 'Server error',
  'transport-error': 'Transport error',
  unknown: 'Unclassified',
};

export function verdictLabel(kind: VerdictKind): string {
  return KIND_LABEL[kind];
}

export function classify(input: ClassifyInput): Verdict {
  const { status, headers, body, transportError } = input;

  if (transportError !== undefined) {
    return {
      kind: 'transport-error',
      envelope: 'none',
      detail: transportError,
    };
  }

  const err = normalizeError(body);
  const haystack = `${err.code ?? ''} ${err.type ?? ''} ${err.message}`.toLowerCase();
  const build = (kind: VerdictKind, detail: string): Verdict => {
    const v: Verdict = { kind, envelope: err.envelope, detail };
    if (err.code !== undefined) v.code = err.code;
    if (err.type !== undefined) v.type = err.type;
    return v;
  };

  if (status >= 200 && status < 300) {
    return { kind: 'ok', envelope: err.envelope, detail: `${status}` };
  }

  // Guardrails answer 400 with a flat envelope — check the marker before the
  // generic 400 branch, or every block reads as a malformed request.
  if (err.code === 'guardrail_violation' || haystack.includes('guardrail')) {
    const name = isRecord(body) ? (asString(body['guardrailName']) ?? '') : '';
    return build('guardrail', name ? `Blocked by guardrail "${name}"` : 'Blocked by content guardrails');
  }

  if (status === 401) {
    return build('auth', err.message || 'Missing or invalid API key');
  }

  if (status === 403) {
    if (haystack.includes('model_not_allowed') || haystack.includes('not allowed for')) {
      return build('model-denied', err.message || 'Key allowedModels does not include this model');
    }
    if (haystack.includes('no_credential') || haystack.includes('credential')) {
      return build('no-credential', err.message || 'No provider credential mapped for this key');
    }
    if (haystack.includes('ip')) {
      return build('ip-blocked', err.message || 'Source IP not in the key allowlist');
    }
    if (haystack.includes('tool')) {
      return build('tool-policy', err.message || 'Tool policy refused this request');
    }
    return build('unknown', err.message || 'Forbidden (unclassified)');
  }

  if (status === 429) {
    const isBudget =
      err.type === 'insufficient_quota' ||
      err.type === 'billing_error' ||
      err.budgetName !== undefined ||
      haystack.includes('budget') ||
      haystack.includes('quota');
    if (isBudget) {
      const name = err.budgetName !== undefined ? ` ("${err.budgetName}")` : '';
      return build('budget', `${err.message || 'Spend cap reached'}${name}`);
    }
    const retry = headers['retry-after'] ?? '';
    const suffix = retry ? ` — retry after ${retry}s` : '';
    return build('ratelimit', `${err.message || 'Per-minute RPM limit'}${suffix}`);
  }

  if (status === 404) return build('not-found', err.message || 'No such route or resource');
  if (status >= 500) return build('server-error', err.message || `Gateway returned ${status}`);
  if (status >= 400) return build('bad-request', err.message || `Rejected with ${status}`);

  return build('unknown', err.message || `Unexpected status ${status}`);
}
