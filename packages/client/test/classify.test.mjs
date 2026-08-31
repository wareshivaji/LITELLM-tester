import { classify, detectEnvelope } from '../dist/index.js';
import { createSuite } from './_harness.mjs';

const { check, done } = createSuite('classifier');

const of = (status, body, headers = {}) => classify({ status, headers, body });

// ── Envelope detection: three shapes, and telling them apart is a finding ────

check('openai envelope', detectEnvelope({ error: { message: 'x', type: 'y' } }), 'openai');
check(
  'anthropic envelope',
  detectEnvelope({ type: 'error', error: { message: 'x', type: 'y' } }),
  'anthropic',
);
check('flat envelope', detectEnvelope({ error: 'moderation not supported' }), 'flat');
check('no envelope on a success body', detectEnvelope({ choices: [] }), 'none');
check('no envelope on a non-object', detectEnvelope('nope'), 'none');

// ── The two 429s. Conflating these is the bug this exists to prevent ─────────

check(
  'budget 429 by type',
  of(429, { error: { message: 'cap', type: 'insufficient_quota' } }).kind,
  'budget',
);
check(
  'budget 429 by budget_name even without the type',
  of(429, { error: { message: 'cap', budget_name: 'Weekly Grp budget' } }).kind,
  'budget',
);
check(
  'anthropic billing_error is a budget rejection',
  of(429, { type: 'error', error: { message: 'cap', type: 'billing_error' } }).kind,
  'budget',
);
check(
  'flat rate-limit 429 is NOT budget',
  of(429, { error: 'rate limit exceeded', retry_after_seconds: 54 }).kind,
  'ratelimit',
);
check(
  'rate-limit detail carries retry-after from the header',
  of(429, { error: 'rate limit exceeded' }, { 'retry-after': '54' }).detail.includes('54'),
  true,
);

// ── The two 403s ─────────────────────────────────────────────────────────────

check(
  'model not allowed',
  of(403, { error: { message: 'Model not allowed for this API key: gpt-4o', code: 'model_not_allowed_for_key' } }).kind,
  'model-denied',
);
check(
  'no provider credential',
  of(403, { error: { message: 'no credential', code: 'no_credential_for_provider' } }).kind,
  'no-credential',
);
check(
  'ip allowlist',
  of(403, { error: { message: 'Your IP address is not allowed' } }).kind,
  'ip-blocked',
);

// ── The guardrail block is a 400, not a 403, and carries a flat envelope ─────

check(
  'guardrail block detected despite the 400',
  of(400, {
    error: 'guardrail_violation',
    message: 'Request blocked by content guardrails',
    guardrailName: 'CUSTOM_CODE',
  }).kind,
  'guardrail',
);
check(
  'guardrail detail names the rule',
  of(400, { error: 'guardrail_violation', guardrailName: 'CUSTOM_CODE' }).detail.includes('CUSTOM_CODE'),
  true,
);
check(
  'a plain 400 is NOT a guardrail',
  of(400, { error: { message: 'Value null at messages', type: 'invalid_request_error' } }).kind,
  'bad-request',
);

// ── Everything else ──────────────────────────────────────────────────────────

check('401', of(401, { error: { message: 'invalid API key' } }).kind, 'auth');
check('404', of(404, { error: { message: 'unknown model: x' } }).kind, 'not-found');
check('501 is a server error', of(501, { error: 'moderation not supported' }).kind, 'server-error');
check('200 is ok', of(200, { choices: [] }).kind, 'ok');
check(
  'transport error short-circuits',
  classify({ status: 0, headers: {}, body: undefined, transportError: 'ECONNREFUSED' }).kind,
  'transport-error',
);
check(
  'code and type are carried through for the client',
  (() => {
    const v = of(401, { error: { message: 'x', type: 'authentication_error', code: 'invalid_api_key' } });
    return [v.code, v.type];
  })(),
  ['invalid_api_key', 'authentication_error'],
);

done();
