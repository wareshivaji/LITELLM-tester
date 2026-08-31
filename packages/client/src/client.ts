/**
 * The customer-facing client.
 *
 * Phase 1 covers the surfaces that cost nothing and touch no provider: the
 * health probe, the connectivity probe Claude clients send at startup, the
 * gateway's own metrics snapshot, and the model catalogue (which doubles as
 * the auth check, since `/v1/models` filters by the key's allowedModels).
 *
 * Inference surfaces land in Phase 2; the method list grows here, the
 * transport underneath never changes.
 */

import type { CreateApiKeyRequest } from './management.js';
import type { SurfaceSpec } from './surfaces.js';
import { Transport } from './transport.js';
import type { TransportInit } from './transport.js';
import type { Exchange, ModelInfo, StreamChunk } from './types.js';

export class TokenShieldClient {
  readonly transport: Transport;

  constructor(init: TransportInit) {
    this.transport = new Transport(init);
  }

  /** `GET /health` — unauthenticated liveness. Proves we reached the gateway. */
  health(timeoutMs?: number): Promise<Exchange> {
    return this.transport.send({
      surface: 'health',
      method: 'GET',
      path: '/health',
      auth: 'none',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * `HEAD /` — the best-effort connectivity probe Claude CLI and Claude Desktop
   * send at session start. Answering it is optional in the protocol, so a
   * non-200 here is a warning, not a failure.
   */
  probeRoot(timeoutMs?: number): Promise<Exchange> {
    return this.transport.send({
      surface: 'probe',
      method: 'HEAD',
      path: '/',
      auth: 'none',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /** `GET /api/v1/metrics` — the gateway's in-process counters. No auth. */
  metrics(timeoutMs?: number): Promise<Exchange> {
    return this.transport.send({
      surface: 'metrics',
      method: 'GET',
      path: '/api/v1/metrics',
      auth: 'none',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * `GET /v1/models` — the catalogue this key is allowed to use.
   *
   * Doubles as the cheapest possible auth check: it runs the full auth
   * middleware, costs nothing, and calls no provider.
   */
  listModels(timeoutMs?: number): Promise<Exchange> {
    return this.transport.send({
      surface: 'models',
      method: 'GET',
      path: '/v1/models',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * Send an arbitrary body to one of the inference surfaces.
   *
   * `body` is deliberately `unknown` and goes out untouched — no validation,
   * no normalisation, no helpful coercion. A client library that "fixes" a
   * malformed request cannot be used to find out how the gateway answers one.
   */
  call(surface: SurfaceSpec, body: unknown, timeoutMs?: number): Promise<Exchange> {
    return this.transport.send({
      surface: surface.id,
      method: surface.method,
      path: surface.path,
      ...(surface.method === 'POST' ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  /**
   * `POST /api/v1/management/api-keys` — mint a new `cg-ak-` key.
   *
   * Authenticated with a management key rather than the client's own
   * credential, so the secret is overridden per call. The response body
   * contains the raw new key: the caller MUST pass the returned Exchange
   * through `redactMintedKey` before it goes anywhere near storage.
   */
  createApiKey(request: CreateApiKeyRequest, managementSecret: string): Promise<Exchange> {
    return this.transport.send({
      surface: 'management.create-key',
      method: 'POST',
      path: '/api/v1/management/api-keys',
      body: request,
      auth: 'x-management-key',
      secret: managementSecret,
    });
  }

  // ── MCP ────────────────────────────────────────────────────────────────
  //
  // The gateway exposes MCP two ways: a REST-ish surface for a console to
  // browse and invoke tools, and URL-addressable Streamable-HTTP endpoints for
  // off-the-shelf MCP clients. All of it is authenticated with the same cg-ak-
  // key, so what a key can see here is part of its entitlement.

  /** `GET /v1/mcp/servers` — enabled servers for this key, tools discovered live. */
  mcpListServers(): Promise<Exchange> {
    return this.transport.send({ surface: 'mcp.servers', method: 'GET', path: '/v1/mcp/servers' });
  }

  /** `GET /v1/mcp/tools` — every tool this key can reach, flattened. */
  mcpListTools(): Promise<Exchange> {
    return this.transport.send({ surface: 'mcp.tools', method: 'GET', path: '/v1/mcp/tools' });
  }

  /** `POST /v1/mcp/servers/test` — probe a registered server with its stored credential. */
  mcpTestServer(server: string): Promise<Exchange> {
    return this.transport.send({
      surface: 'mcp.servers.test',
      method: 'POST',
      path: '/v1/mcp/servers/test',
      body: { server },
    });
  }

  /** `POST /v1/mcp/tools/call` — invoke one tool directly, no model in the loop. */
  mcpCallTool(server: string, name: string, args: unknown): Promise<Exchange> {
    return this.transport.send({
      surface: 'mcp.tools.call',
      method: 'POST',
      path: '/v1/mcp/tools/call',
      body: { server, name, arguments: args },
    });
  }

  /**
   * `POST /v1/mcp` — the Streamable-HTTP aggregate, spoken by off-the-shelf MCP
   * clients. Takes a JSON-RPC envelope; `tools/list` is the useful probe.
   */
  mcpAggregate(rpc: unknown): Promise<Exchange> {
    return this.transport.send({
      surface: 'mcp.aggregate',
      method: 'POST',
      path: '/v1/mcp',
      body: rpc,
      accept: 'application/json, text/event-stream',
    });
  }

  /**
   * The same call, read as a stream. The body is still passed through
   * untouched — including whether it says `stream: true`, which is the
   * caller's business: sending `stream: false` to this method is itself a
   * worthwhile test of what the gateway does.
   */
  callStream(
    surface: SurfaceSpec,
    body: unknown,
    options: { onChunk?: (chunk: StreamChunk) => void; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Exchange> {
    return this.transport.stream({
      surface: surface.id,
      method: surface.method,
      path: surface.path,
      body,
      ...(options.onChunk !== undefined ? { onChunk: options.onChunk } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }
}

/** Reads `{object:"list", data:[…]}` defensively — a shape change is a finding, not a crash. */
export function extractModels(body: unknown): ModelInfo[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string') continue;
    const model: ModelInfo = {
      id,
      object: typeof record['object'] === 'string' ? record['object'] : 'model',
      owned_by: typeof record['owned_by'] === 'string' ? record['owned_by'] : '',
    };
    if (typeof record['display_name'] === 'string') model.display_name = record['display_name'];
    if (typeof record['anthropic_family_tier'] === 'string') {
      model.anthropic_family_tier = record['anthropic_family_tier'];
    }
    out.push(model);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
