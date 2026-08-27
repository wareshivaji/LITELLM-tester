/**
 * The vocabulary of the lab.
 *
 * Everything the SDK does produces exactly one `Exchange`. The backend stores
 * them, the UI renders them, the scenario runner asserts on them. Keeping one
 * record type means a call made from the Playground, from a scenario and from
 * a vendor SDK adapter are all directly comparable.
 */

/** A gateway deployment we can point at. */
export interface Profile {
  id: string;
  label: string;
  /** No `/v1` suffix — each surface appends its own path. */
  baseUrl: string;
}

/**
 * Where a target came from. `file` entries are declared in `.env.local` and
 * survive a restart; `session` entries were typed into the console and live
 * only in the backend's memory. The distinction is shown in the UI because
 * losing a target on restart should never be a surprise.
 */
export type TargetSource = 'file' | 'session';

export interface LabProfile extends Profile {
  source: TargetSource;
}

export type KeyKind = 'api' | 'management' | 'admin';

/** What the UI is allowed to know about a credential. Never the raw value. */
export interface KeyRef {
  alias: string;
  kind: KeyKind;
  masked: string;
}

export interface LabKeyRef extends KeyRef {
  source: TargetSource;
}

/**
 * How the credential is presented. TokenShield accepts a `cg-ak-` key as
 * either `Authorization: Bearer` or `x-api-key`, and clients in the wild use
 * both — so which one was used is part of the record.
 */
export type AuthScheme = 'bearer' | 'x-api-key' | 'x-management-key' | 'x-admin-key' | 'none';

/**
 * Which error shape came back. This is a finding in its own right: the gateway
 * answers with OpenAI's envelope on most of /v1, Anthropic's on /v1/messages*,
 * and a flat `{"error":"..."}` from a few handlers that predate apierror.
 */
export type ErrorEnvelope = 'openai' | 'anthropic' | 'flat' | 'none';

/** Named cause of an outcome — the whole point of the classifier. */
export type VerdictKind =
  | 'ok'
  | 'auth'
  | 'model-denied'
  | 'no-credential'
  | 'budget'
  | 'ratelimit'
  | 'guardrail'
  | 'ip-blocked'
  | 'tool-policy'
  | 'not-found'
  | 'bad-request'
  | 'server-error'
  | 'transport-error'
  | 'unknown';

export interface Verdict {
  kind: VerdictKind;
  envelope: ErrorEnvelope;
  /** One plain sentence a human can act on. */
  detail: string;
  /** `error.code` / `error.type` as the gateway sent them, when present. */
  code?: string;
  type?: string;
  /** Set when this outcome matches a registered known landmine (Phase 7). */
  landmineId?: string;
}

export interface BudgetScope {
  limit?: number;
  spend?: number;
  warning?: string;
}

/** The four budget scopes the gateway reports through response headers. */
export interface BudgetSnapshot {
  request?: BudgetScope;
  key?: BudgetScope;
  user?: BudgetScope;
  group?: BudgetScope;
}

/** Gateway-specific signal lifted out of the response headers. */
export interface GatewaySignal {
  requestId?: string;
  organizationId?: string;
  retryAfterSeconds?: number;
  shouldRetry?: string;
  guardrailMs?: number;
  mcpSessionId?: string;
  budget?: BudgetSnapshot;
}

export interface ExchangeRequest {
  method: string;
  url: string;
  path: string;
  /** Already redacted — no raw secret ever enters an Exchange. */
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
}

export interface StreamChunk {
  /** ms since the request started. */
  t: number;
  raw: string;
  parsed?: unknown;
}

export interface ExchangeResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: unknown;
  bodyText?: string;
  chunks?: StreamChunk[];
}

export interface Timings {
  startedAt: string;
  /** Time to first byte — resolves when response headers arrive. */
  ttfbMs: number;
  totalMs: number;
  guardrailMs?: number;
}

export type ExchangeMode = 'raw' | 'openai-sdk' | 'anthropic-sdk';

export interface Exchange {
  id: string;
  /**
   * Which gateway this actually hit, stamped on every single record.
   * The most expensive class of past bug was "which target did that run go to?"
   */
  profileId: string;
  profileLabel: string;
  baseUrl: string;
  keyAlias: string | null;
  authScheme: AuthScheme;
  surface: string;
  mode: ExchangeMode;
  request: ExchangeRequest;
  response?: ExchangeResponse;
  timings: Timings;
  gateway: GatewaySignal;
  verdict: Verdict;
  /** Set only when the request never reached a response (DNS, refused, timeout). */
  transportError?: string;
}

/**
 * The list-row view of an Exchange. Small enough to send hundreds of, and
 * shared by the backend's history endpoint and the UI's log table so the two
 * cannot drift.
 */
export interface ExchangeSummary {
  id: string;
  profileId: string;
  profileLabel: string;
  baseUrl: string;
  keyAlias: string | null;
  surface: string;
  mode: ExchangeMode;
  method: string;
  path: string;
  status: number | null;
  verdictKind: VerdictKind;
  envelope: ErrorEnvelope;
  totalMs: number;
  startedAt: string;
}

/** One entry from `GET /v1/models`, as the gateway defines it. */
export interface ModelInfo {
  id: string;
  object: string;
  owned_by: string;
  display_name?: string;
  anthropic_family_tier?: string;
}

export interface ModelListResponse {
  object: string;
  data: ModelInfo[];
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Links the check to the Exchange that produced it, for the inspector. */
  exchangeId?: string;
  latencyMs?: number;
}

export interface PreflightResult {
  profile: Profile;
  keyAlias: string | null;
  authScheme: AuthScheme;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  checks: PreflightCheck[];
  models: ModelInfo[];
  metrics?: unknown;
  exchanges: Exchange[];
}
