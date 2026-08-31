/**
 * An MCP server the lab runs itself.
 *
 * ## Why this exists
 *
 * Everything MCP was previously blocked on someone else: an org with a
 * configured MCP server, and a gateway that was up. That made the lab
 * un-runnable for the exact feature it was built to test, and it meant every
 * expectation was ultimately measured against the gateway — which can only
 * confirm the gateway does what it does.
 *
 * Running our own server inverts that. It is the **instrument**, not the
 * subject: it records precisely what arrives, so questions the LiteLLM docs
 * leave open stop needing a cooperative environment to answer.
 *
 * ## What it answers that nothing else could
 *
 *  - **Namespacing.** LiteLLM documents `{server}_{tool}` with one underscore;
 *    TokenShield's own comment says two. Register a tool here and read back the
 *    name the gateway advertises.
 *  - **Credential leakage.** LiteLLM's troubleshooting guide warns that the
 *    proxy's own API key can leak to the MCP server in place of a proper token.
 *    This server records every header it receives, so "did the customer's
 *    `cg-ak-` key reach a third party" becomes a lookup rather than a worry.
 *  - **Header forwarding.** Whether `x-mcp-{alias}-{header}` arrives, and under
 *    what name.
 *  - **Failure envelopes.** Undocumented upstream, so they have to be observed:
 *    this server can fail on demand and the gateway's translation gets recorded.
 *
 * ## Deliberate limits
 *
 * Not a general MCP implementation and not trying to be. It speaks the subset a
 * gateway exercises — `initialize`, `tools/list`, `tools/call` — over JSON-RPC,
 * and nothing else. Anything beyond that returns a proper JSON-RPC error rather
 * than a vague 500, because a wrong answer from the instrument is worse than no
 * answer.
 *
 * Still no database: the request log is a bounded in-memory ring, consistent
 * with the rest of the lab.
 */

import { summariseCredentialExposure } from '@tokenshield/client';
import type { FastifyInstance } from 'fastify';

/** A tool this server advertises. Kept trivial and deterministic on purpose. */
export interface MockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What `tools/call` returns. A fixed value, so a wrong answer is obvious. */
  result: unknown;
}

export const MOCK_TOOLS: readonly MockTool[] = [
  {
    name: 'lab_echo',
    description: 'Returns its argument unchanged. Proves the round trip and nothing else.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Anything' } },
      required: ['text'],
    },
    result: { echoed: true },
  },
  {
    name: 'lab_weather',
    description: 'A canned forecast. Deliberately absurd so a real provider answer cannot be mistaken for it.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    // If this string ever appears in a model's answer, the tool genuinely ran.
    result: { forecast: 'raining upward at 3 degrees', source: 'tokenshield-lab-mock' },
  },
];

/** One recorded inbound request. Headers are kept RAW here — see the note. */
export interface McpRequestRecord {
  seq: number;
  at: string;
  method: string;
  path: string;
  /**
   * Every header, unredacted.
   *
   * This is the one place in the lab that deliberately keeps raw header values,
   * because the question being asked *is* "did a credential arrive here". The
   * read endpoint redacts on the way out; what it reports instead is which
   * secrets were **detected**, by name and by shape. So the answer survives
   * without the value being handed to anyone.
   */
  headers: Record<string, string>;
  body: unknown;
  /** JSON-RPC method, when the body is a JSON-RPC envelope. */
  rpcMethod: string | null;
}

/** Behaviour switches, so failure paths can be exercised on demand. */
export interface MockMcpMode {
  /** Fail `tools/call` with a JSON-RPC error. */
  failCalls: boolean;
  /** Fail `tools/list`, to see how a gateway reports discovery failure. */
  failList: boolean;
  /** Answer nothing at all, to see how a gateway reports a hung server. */
  hang: boolean;
}

const HISTORY_CAP = 100;

export class MockMcpServer {
  private readonly log: McpRequestRecord[] = [];
  private seq = 0;
  private mode: MockMcpMode = { failCalls: false, failList: false, hang: false };

  get requests(): readonly McpRequestRecord[] {
    return this.log;
  }

  get currentMode(): MockMcpMode {
    return { ...this.mode };
  }

  setMode(patch: Partial<MockMcpMode>): MockMcpMode {
    this.mode = { ...this.mode, ...patch };
    return this.currentMode;
  }

  reset(): void {
    this.log.length = 0;
    this.seq = 0;
  }

  record(entry: Omit<McpRequestRecord, 'seq' | 'at'>): McpRequestRecord {
    this.seq += 1;
    const full: McpRequestRecord = { seq: this.seq, at: new Date().toISOString(), ...entry };
    this.log.push(full);
    if (this.log.length > HISTORY_CAP) this.log.shift();
    return full;
  }
}

/** JSON-RPC error codes, from the spec. Using the right code is the point. */
const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

function rpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Mount the mock at `/mock-mcp`.
 *
 * Bound to the same loopback interface as the rest of the lab, so it is
 * reachable by a local gateway (`MCP_TEST_ALLOW_LOOPBACK=true`) and by nothing
 * else.
 */
export function registerMockMcp(app: FastifyInstance, mock: MockMcpServer): void {
  // ── The MCP endpoint itself ────────────────────────────────────────────────
  app.post('/mock-mcp', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const id = body?.['id'];
    const method = typeof body?.['method'] === 'string' ? (body['method'] as string) : null;

    mock.record({
      method: 'POST',
      path: '/mock-mcp',
      headers: request.headers as Record<string, string>,
      body: body ?? null,
      rpcMethod: method,
    });

    if (mock.currentMode.hang) {
      // Never answer. The caller's own timeout is the thing under test.
      await new Promise(() => {});
    }

    if (body === undefined || body === null || typeof body !== 'object') {
      return reply.status(200).send(rpcError(null, RPC.parseError, 'Body is not a JSON-RPC object'));
    }
    if (body['jsonrpc'] !== '2.0') {
      return reply.status(200).send(rpcError(id, RPC.invalidRequest, 'jsonrpc must be "2.0"'));
    }
    if (method === null) {
      return reply.status(200).send(rpcError(id, RPC.invalidRequest, 'Missing "method"'));
    }

    switch (method) {
      case 'initialize':
        // A session id is assigned here, which is what the MCP Streamable HTTP
        // transport expects and what our gateway was measured NOT to do.
        void reply.header('Mcp-Session-Id', `lab-${Date.now().toString(36)}`);
        return reply.status(200).send(
          rpcResult(id, {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'tokenshield-lab-mock', version: '0.1.0' },
          }),
        );

      case 'notifications/initialized':
        return reply.status(202).send();

      case 'tools/list':
        if (mock.currentMode.failList) {
          return reply
            .status(200)
            .send(rpcError(id, RPC.internalError, 'tools/list failed on purpose (lab mode)'));
        }
        return reply.status(200).send(
          rpcResult(id, {
            tools: MOCK_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          }),
        );

      case 'tools/call': {
        if (mock.currentMode.failCalls) {
          return reply
            .status(200)
            .send(rpcError(id, RPC.internalError, 'tools/call failed on purpose (lab mode)'));
        }
        const params = (body['params'] ?? {}) as Record<string, unknown>;
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const tool = MOCK_TOOLS.find((t) => t.name === name);
        if (tool === undefined) {
          return reply
            .status(200)
            .send(rpcError(id, RPC.invalidParams, `Unknown tool "${name}"`));
        }
        return reply.status(200).send(
          rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(tool.result) }],
            isError: false,
          }),
        );
      }

      default:
        return reply.status(200).send(rpcError(id, RPC.methodNotFound, `Unknown method "${method}"`));
    }
  });

  // ── Reading what arrived ───────────────────────────────────────────────────
  /**
   * The recorded traffic, with header VALUES masked and the credential question
   * answered separately. A caller learns "a cg-ak- key arrived, in the
   * authorization header" without the key being handed back to them.
   */
  app.get('/api/mock-mcp/requests', () => ({
    baseUrl: 'http://127.0.0.1:8787/mock-mcp',
    mode: mock.currentMode,
    tools: MOCK_TOOLS.map((t) => t.name),
    total: mock.requests.length,
    requests: mock.requests.map((r) => {
      const creds = summariseCredentialExposure(r.headers);
      return {
        seq: r.seq,
        at: r.at,
        rpcMethod: r.rpcMethod,
        headerNames: Object.keys(r.headers).sort(),
        ...creds,
        body: r.body,
      };
    }),
  }));

  app.post('/api/mock-mcp/mode', (request) => {
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const patch: Partial<MockMcpMode> = {};
    if (typeof raw['failCalls'] === 'boolean') patch.failCalls = raw['failCalls'];
    if (typeof raw['failList'] === 'boolean') patch.failList = raw['failList'];
    if (typeof raw['hang'] === 'boolean') patch.hang = raw['hang'];
    return { mode: mock.setMode(patch) };
  });

  app.post('/api/mock-mcp/reset', () => {
    mock.reset();
    return { ok: true, total: 0 };
  });
}
