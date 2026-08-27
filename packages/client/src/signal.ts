/**
 * Lifts the gateway's own telemetry out of the response headers.
 *
 * This is the reason the lab has a backend at all. The gateway sets
 * `AllowOrigins: "*"` but never sets `ExposeHeaders`
 * (internal/server/server.go), so a browser can only read the six
 * CORS-safelisted response headers. `X-Request-ID`, every `X-*-Budget-*`,
 * `x-should-retry`, `Retry-After` and `x-tokenshield-guardrail-ms` are
 * invisible to page JavaScript — and they are half the signal we came for.
 */

import type { BudgetScope, BudgetSnapshot, GatewaySignal } from './types.js';

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads one budget scope's trio of headers, or undefined if none are present. */
function scope(headers: Record<string, string>, prefix: string): BudgetScope | undefined {
  const limit = num(headers[`${prefix}-limit`]);
  const spend = num(headers[`${prefix}-spend`]);
  const warning = headers[`${prefix}-warning`];
  if (limit === undefined && spend === undefined && warning === undefined) return undefined;
  const out: BudgetScope = {};
  if (limit !== undefined) out.limit = limit;
  if (spend !== undefined) out.spend = spend;
  if (warning !== undefined) out.warning = warning;
  return out;
}

export function parseBudget(headers: Record<string, string>): BudgetSnapshot | undefined {
  const snapshot: BudgetSnapshot = {};
  const request = scope(headers, 'x-budget');
  const key = scope(headers, 'x-key-budget');
  const user = scope(headers, 'x-user-budget');
  const group = scope(headers, 'x-group-budget');
  if (request !== undefined) snapshot.request = request;
  if (key !== undefined) snapshot.key = key;
  if (user !== undefined) snapshot.user = user;
  if (group !== undefined) snapshot.group = group;
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** Header names are lowercased by the caller before this runs. */
export function parseGatewaySignal(headers: Record<string, string>): GatewaySignal {
  const signal: GatewaySignal = {};

  const requestId = headers['x-request-id'];
  const organizationId = headers['x-organization-id'];
  const shouldRetry = headers['x-should-retry'];
  const mcpSessionId = headers['mcp-session-id'];
  const retryAfter = num(headers['retry-after']);
  const guardrailMs = num(headers['x-tokenshield-guardrail-ms']);
  const budget = parseBudget(headers);

  if (requestId !== undefined) signal.requestId = requestId;
  if (organizationId !== undefined) signal.organizationId = organizationId;
  if (shouldRetry !== undefined) signal.shouldRetry = shouldRetry;
  if (mcpSessionId !== undefined) signal.mcpSessionId = mcpSessionId;
  if (retryAfter !== undefined) signal.retryAfterSeconds = retryAfter;
  if (guardrailMs !== undefined) signal.guardrailMs = guardrailMs;
  if (budget !== undefined) signal.budget = budget;

  return signal;
}
