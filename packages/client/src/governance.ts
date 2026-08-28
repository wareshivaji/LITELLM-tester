/**
 * The gates a request passes through, and how to make each one fire.
 *
 * Every one of these is a *rejection* the gateway is supposed to produce. The
 * useful question is not "does it reject" but "does it reject in a way a client
 * can act on" — the right status, a parseable envelope, and a reason that names
 * which gate fired rather than leaving the developer to guess between a spend
 * cap and a rate limit.
 *
 * Each gate records what it needs before it can be tested at all. Several
 * cannot be exercised on a shared production key: a $100 budget with real
 * traffic against it will not hit its cap for a test, and a key that already
 * has an IP allowlist covering this machine will never refuse it. Those need a
 * disposable key minted for the purpose, which is why key minting lives on the
 * same page.
 */

import type { VerdictKind } from './types.js';

export interface Gate {
  id: string;
  label: string;
  /** What the gate is for. */
  what: string;
  /** How the console makes it fire. */
  how: string;
  /** The verdict the classifier should return when it does. */
  expects: VerdictKind;
  /** A precondition that is not satisfiable from the console alone. */
  requires?: string;
  /** Whether tripping it reaches a provider and therefore costs money. */
  spends: boolean;
  /** Anything about tripping it that affects other people. */
  caution?: string;
}

export const GATES: readonly Gate[] = [
  {
    id: 'allowed-models',
    label: 'allowedModels',
    what: 'Restricts a key to a named set of models.',
    how: 'Ask for a model the gateway knows but this key is not allowed to use.',
    expects: 'model-denied',
    spends: false,
  },
  {
    id: 'rate-limit',
    label: 'Rate limit (RPM)',
    what: 'Caps requests per minute per key, and per org. Default 60.',
    how: 'Burst GET /v1/models until it refuses — that route runs the full middleware chain but calls no provider, so the burst is free.',
    expects: 'ratelimit',
    spends: false,
    caution:
      'The limiter is real and shared. Tripping it consumes this key’s minute-window, so anything else using the same key will be refused until the window rolls.',
  },
  {
    id: 'key-budget',
    label: 'Key budget cap',
    what: 'Refuses a key once its spend passes a limit, per period.',
    how: 'Mint a key with a two-cent cap, then spend it. Watch X-Key-Budget-Spend climb, then the 429.',
    expects: 'budget',
    requires: 'A disposable key with a small budget_limit_usd — mint one above.',
    spends: true,
  },
  {
    id: 'ip-allowlist',
    label: 'IP allowlist',
    what: 'Restricts a key to named source IPs or CIDRs.',
    how: 'Mint a key allowing an address this machine does not have, then use it.',
    expects: 'ip-blocked',
    requires: 'A disposable key with an ip_allow_list that excludes this machine.',
    spends: false,
  },
  {
    id: 'provider-binding',
    label: 'Provider credential',
    what: 'A key can only reach providers it has a credential mapped for.',
    how: 'Ask for a model belonging to a provider this key has no credential for.',
    expects: 'no-credential',
    spends: false,
  },
  {
    id: 'guardrail',
    label: 'Guardrail',
    what: 'Blocks prompts matching the org’s content rules, before any provider call.',
    how: 'Send a prompt that matches a configured rule.',
    expects: 'guardrail',
    requires:
      'A guardrail rule configured on the org. Measured 2026-08-27 this org has none — x-tokenshield-guardrail-ms was 0, meaning the middleware ran with nothing to apply.',
    spends: false,
  },
];

export function gateById(id: string): Gate | undefined {
  return GATES.find((g) => g.id === id);
}

/**
 * Model ids worth trying when hunting for one this key may not use.
 *
 * The distinction that matters: a model the gateway has never heard of returns
 * **404 unknown model**, while a model it routes but this key is not allowed to
 * use returns **403 model_not_allowed_for_key**. Only the second exercises the
 * gate, so the console tries a spread of plausible ids from other providers and
 * reports which status each produced.
 */
export const CROSS_PROVIDER_PROBES: readonly string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'azure-gpt-4o',
  'gemini-2.0-flash',
  'gemini-embedding-001',
  'vertex-gemini-2.0-flash',
  'claude-sonnet-4',
  'text-embedding-3-small',
];
