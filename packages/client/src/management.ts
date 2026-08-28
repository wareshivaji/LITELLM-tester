/**
 * Minting API keys with a management key.
 *
 * A `cg-mk-` management key can create `cg-ak-` keys without going near the
 * admin console, which is what makes governance testable at all: a budget cap
 * cannot be exercised on a key whose budget is $100 and whose spend is shared
 * with real traffic. The answer is a disposable key with a two-cent cap.
 *
 * **This is the one response in the whole tool that contains a live
 * credential.** `POST /api/v1/management/api-keys` returns the raw new key in
 * its body — shown once, never again. Recorded naively it would sit in the
 * exchange log, in the inspector, and in every export of them. So the caller
 * must run the Exchange through `redactMintedKey` before storing it, and the
 * only place the raw value survives is the backend's in-memory registry.
 */

import { maskSecret, scrubText } from './redact.js';
import type { Exchange } from './types.js';

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const BUDGET_PERIODS: readonly BudgetPeriod[] = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
];

/**
 * The management API's request shape, from MANAGEMENT_API_SPEC.md. Note there
 * is no credential-id field: providers are selected by name only.
 */
export interface CreateApiKeyRequest {
  name: string;
  budget_limit_usd?: number;
  budget_period?: BudgetPeriod;
  expires_in_days?: number;
  allowed_models?: string[];
  providers?: unknown[];
  ip_allow_list?: string[];
  alert_emails?: string[];
  application?: string;
  purpose?: string;
}

export interface CreatedApiKey {
  id: string;
  /** The raw key. Shown once by the gateway and never again. */
  api_key: string;
  api_key_prefix?: string;
  name?: string;
}

/** Reads the mint response defensively — a shape change must not lose the key. */
export function readCreatedKey(body: unknown): CreatedApiKey | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const apiKey = record['api_key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) return undefined;
  const created: CreatedApiKey = {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    api_key: apiKey,
  };
  if (typeof record['api_key_prefix'] === 'string') created.api_key_prefix = record['api_key_prefix'];
  if (typeof record['name'] === 'string') created.name = record['name'];
  return created;
}

/**
 * Replaces the minted key everywhere it appears in a recorded exchange.
 *
 * Called immediately after minting and before the exchange reaches the store.
 * The body is re-parsed from the scrubbed text so the structured copy cannot
 * disagree with the raw one.
 */
export function redactMintedKey(exchange: Exchange, mintedKey: string): Exchange {
  if (exchange.response === undefined || mintedKey.length === 0) return exchange;

  const bodyText = exchange.response.bodyText;
  if (bodyText === undefined || !bodyText.includes(mintedKey)) return exchange;

  const scrubbed = scrubText(bodyText, [mintedKey]);
  const response = { ...exchange.response, bodyText: scrubbed };
  try {
    response.body = JSON.parse(scrubbed);
  } catch {
    delete response.body;
  }
  return { ...exchange, response };
}

/** Everything the browser may know about a freshly minted key. */
export interface MintedKeySummary {
  alias: string;
  masked: string;
  id: string;
  name: string;
}

export function summariseMintedKey(
  alias: string,
  created: CreatedApiKey,
  name: string,
): MintedKeySummary {
  return { alias, masked: maskSecret(created.api_key), id: created.id, name };
}
