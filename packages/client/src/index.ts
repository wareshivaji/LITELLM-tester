/**
 * The lab client package.
 *
 * ## What is NOT here any more, since 2026-09-08 (Phase 8.2)
 *
 * `classify`, `signal`, `transport` and `client` were deleted — 1,087 lines.
 * They were the HTTP-and-verdict stack, and the Python engine owns that
 * outright now: it serves every endpoint, and `adapters.ts` does its own
 * `fetch` since D-7 rather than borrowing `Transport`. Keeping a second
 * implementation to be "kept honest" against the first is the mistake that cost
 * 1,826 lines in the aborted Go migration.
 *
 * What survives here is what has exactly one implementation: the browser's own
 * helpers (surfaces, fields, probes, tools, mcp, stream analysis, curl,
 * governance), the redaction the browser and the probe both need, the SSE
 * parser the web uses directly, and the vendor-SDK adapter that IS the probe.
 */
export * from './types.js';
export {
  buildPromptBody,
  comparePromptOutcomes,
  estimateRun,
  evaluatePromptOutcome,
  mcpToolBlock,
  PROMPT_CASES,
  PROMPT_SURFACES,
  readAnswerText,
  readPromptToolCalls,
  summarisePromptResult,
} from './prompts.js';
export type {
  BuildOptions,
  PromptCase,
  PromptComparison,
  PromptExpectation,
  PromptOutcome,
  PromptResult,
  PromptSurfaceId,
} from './prompts.js';
export {
  isSecretBodyKey,
  isSecretHeader,
  maskSecret,
  redactBody,
  redactHeaders,
  scrubText,
  summariseCredentialExposure,
} from './redact.js';
export {
  INSTRUMENTS,
  isStreamable,
  readOutput,
  readUsage,
  STREAMING_SURFACES,
  SURFACES,
  surfaceById,
  withStreaming,
  // Moved here from adapters.ts on 2026-09-08 so the web can import it without
  // binding the browser build to the vendor SDKs. See the note in surfaces.ts.
  ANTHROPIC_SDK_SURFACES,
  OPENAI_SDK_SURFACES,
  sdkModesFor,
} from './surfaces.js';
export type { SurfaceFamily, SurfaceOutput, SurfaceSpec, UsageSummary } from './surfaces.js';
export { FLAT_ENVELOPE_SURFACE, PROBES, probesFor } from './probes.js';
export type { Probe, ProbeExpectation } from './probes.js';
export { toCurl } from './curl.js';
export { SSEParser } from './sse.js';
export { analyseStream, checkResponsesLifecycle, gapMs, readStreamDelta } from './stream.js';
export type { LifecycleReport } from './stream.js';
export type { StreamAnalysis, StreamAnomaly } from './stream.js';
export {
  runWithSdk,
} from './adapters.js';
export type {
  AdapterInit,
  ProbeAttempt,
  ProbeOutcome,
  SdkFailure,
  SdkMode,
  SdkOutcome,
} from './adapters.js';
export {
  BUDGET_PERIODS,
  readCreatedKey,
  redactMintedKey,
  summariseMintedKey,
} from './management.js';
export type {
  BudgetPeriod,
  CreateApiKeyRequest,
  CreatedApiKey,
  MintedKeySummary,
} from './management.js';
export { CROSS_PROVIDER_PROBES, GATES, gateById } from './governance.js';
export {
  checkToolCalls,
  extractToolCalls,
  looksSwallowed,
  summariseTurn,
  TOOL_PRESETS,
  toolPresetById,
} from './tools.js';
export type { ToolCall, ToolCallIssue, ToolPreset, ToolTurn } from './tools.js';
export { extractResponsesToolCalls } from './tools.js';
export {
  CHAT_FIELDS,
  FIELD_GAPS,
  fieldsFor,
  gapsMovingTo,
  isUnknownField,
  RESPONSES_FIELDS,
  sharedFields,
  unknownFieldsIn,
} from './fields.js';
export type { FieldGap } from './fields.js';
export {
  serverSlug,
  wireNameFor,
  withWireNames,
  buildMcpAuthHeader,
  checkMcpAuthScoping,
  groupMcpAuthHeaders,
  parseMcpAuthHeader,
  checkMcpItems,
  offeredToolNames,
  readMcpBrokeredCalls,
  readMcpListings,
  readMcpServers,
  readMcpTools,
  readMcpToolEvent,
  readPolicy,
  summariseMcpCalls,
  tallyPolicies,
} from './mcp.js';
export type {
  WireName,
  McpServerWithWires,
  McpToolWithWire,
  McpAuthHeader,
  McpBrokeredCall,
  McpItemIssue,
  McpListing,
  McpOfferedTool,
} from './mcp.js';
export type {
  McpCallSummary,
  McpPolicy,
  McpServer,
  McpTool,
  McpToolEvent,
  PolicyTally,
} from './mcp.js';
export {
  checkExpectation,
  evaluateScenario,
  reportToMarkdown,
  SUITES,
  suiteById,
  tally,
} from './scenarios.js';
export type {
  Expectation,
  Scenario,
  ScenarioContext,
  ScenarioOutcome,
  ScenarioReport,
  ScenarioResult,
  Suite,
} from './scenarios.js';
export type { Gate } from './governance.js';
export type { McpEntitlement } from './mcp.js';
