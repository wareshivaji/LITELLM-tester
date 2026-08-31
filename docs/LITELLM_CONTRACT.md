# The LiteLLM / OpenAI contract the lab tests against

**This file, not the gateway, is the source of truth for expectations.**

Read from <https://docs.litellm.ai/docs/mcp> and
<https://docs.litellm.ai/docs/mcp_troubleshoot> on **2026-08-31**, and from the vendored
`openai@4.104.0` TypeScript definitions in `node_modules/openai/resources/`.

Why it is separate from `GATEWAY_SURFACE.md`: that file records what *our* gateway does. This one
records what a client is **entitled to**. Keeping them apart is the whole point — measuring the
gateway against itself can only ever confirm it does what it does.

---

## 1. Correction to an earlier claim

I previously stated, twice and with confidence, that `/v1/chat/completions` has **no** MCP tool type
and therefore transparent brokering was the only conformant design there. That was read off the
`openai` SDK's own union, where the only tool type is `function`.

It is **wrong as a statement about LiteLLM.** LiteLLM accepts a `{"type": "mcp"}` block in `tools`
on `/chat/completions`:

```json
{ "type": "mcp",
  "server_url": "litellm_proxy/github/mcp",
  "server_label": "github_mcp",
  "require_approval": "never" }
```

So the correct statement is narrower: *OpenAI's own* chat-completions API has no MCP tool type, but
LiteLLM extends it, and a client following LiteLLM may declare MCP there directly.

**What LiteLLM does with it:** with `require_approval: "never"` the proxy *"automatically executes
the returned tool calls and feeds the results back into the model before returning the assistant
response"*. So the declaration is explicit and the brokering is transparent — both, not either.

## 2. Tool naming

> "LiteLLM namespaces multiple MCP servers by prefixing each tool name with its MCP server name."

Pattern: **`{server_name}_{tool_name}`** — a **single** underscore. Documented example:
`github_mcp-search_issues`.

`litellm_settings.mcp_aliases` maps friendly names (`github`) onto server names.

**Divergence to check:** TokenShield's own source comment says `<server>__<tool>` — a **double**
underscore. If that is what it emits, a client that splits on the documented single underscore
mis-parses every aggregated tool name. Untested against a running gateway; recorded as a question,
not a finding.

## 3. Headers

| Header | Meaning |
|---|---|
| `x-litellm-api-key` | proxy authentication |
| `x-mcp-servers` | which MCP servers this request may reach — **confirms** the scoping header |
| `x-mcp-{server_alias}-{header_name}` | per-server auth. The **recommended** form |
| `x-mcp-auth` | legacy, **deprecated** |
| `x-litellm-end-user-id` | end-user attribution for permissions and budgets |

`${X-HEADER_NAME}` maps an inbound HTTP header into a stdio server's environment.

Every one of these is already covered by the lab's `isSecretHeader` prefix rule (`x-mcp-`), so
per-server credentials are masked wherever the lab records them.

## 4. Endpoints

| Path | Purpose |
|---|---|
| `/mcp` | the MCP gateway itself |
| `/mcp-rest/tools/list`, `/mcp-rest/tools/call` | REST, for calling a tool with no LLM in the loop |
| `/v1/chat/completions` | accepts `type:"mcp"` tool blocks |
| `/v1/responses` | accepts `type:"mcp"` tool blocks |

Convention: when pointing LiteLLM at its own MCP gateway, `server_url` is the literal
`"litellm_proxy"` (optionally `litellm_proxy/{alias}/mcp`).

## 5. Access control

By API key, by team, by organisation, per-user via `x-litellm-end-user-id`, and a server-level
`allow_all_keys`. So per-key scoping *is* a LiteLLM concept after all — what appears to have no
LiteLLM equivalent is per-**tool** blocking at key level. The `cloudgov` reference value stays, with
that narrower justification.

## 6. Error shapes — mostly undocumented

The docs do **not** specify what comes back when an MCP tool fails, a server is unreachable, a key
lacks permission, or a name in `x-mcp-servers` does not exist. What the troubleshooting guide does
show:

- `HTTP/1.1 400 Bad Request` with **`{"detail":"invalid_request"}`** on OAuth redirect validation
  failure. Note the shape: FastAPI's flat `detail`, **not** an OpenAI error envelope. So LiteLLM
  itself is not OpenAI-shaped on this path, which weakens any argument that our gateway's flat
  envelopes are uniquely wrong — though it does not make them parseable by an OpenAI SDK.
- Connection failures surface as text: `"MCP client list_tools failed - Error Type: ExceptionGroup"`,
  `"httpx.ConnectError: All connection attempts failed"`.
- Debug headers `x-mcp-debug-oauth2-token: Bearer****ef01` and `x-mcp-debug-auth-resolution`. Note
  LiteLLM masks the token but keeps the **last four** characters.

**The security finding worth borrowing.** The guide warns that `SAME_AS_LITELLM_KEY` in the OAuth
token field means *the proxy's own API key is leaking to the MCP server* instead of a proper token.
That is a concrete, testable credential-leak mode: a gateway must not forward the customer's gateway
key to a third-party MCP server. The lab tests it with its own MCP server, which records exactly
what arrives — see `docs/PLAN-CLIENT-MCP.md`.

Because error shapes are undocumented, expectations about them cannot be `reference: 'litellm'`.
They are questions the lab answers by observation, and observations get `measured`.

## 7. The OpenAI Responses contract

From the vendored SDK, so checkable:

**Tool block:** `{type:'mcp', server_label, server_url}` required; `allowed_tools`
(`string[]` **or** `{tool_names}`), `headers`, `require_approval` (`'always' | 'never' | filter`)
optional.

**Output items:** `mcp_list_tools` (`id`, `server_label`, `tools[]`, `error?`) · `mcp_call` (`id`,
`name`, `arguments`, `server_label`, `output?`, `error?`) · `mcp_approval_request` (`id`, `name`,
`arguments`, `server_label`) · `mcp_approval_response`.

**Stream events — eight, exactly:**

```
response.mcp_call.in_progress       response.mcp_list_tools.in_progress
response.mcp_call.arguments_delta   response.mcp_list_tools.completed
response.mcp_call.arguments_done    response.mcp_list_tools.failed
response.mcp_call.completed
response.mcp_call.failed
```

TokenShield emits `mcp_tool_call`, which is none of these. An OpenAI-SDK stream parser does not
error on an unknown event — it **drops** it, so brokered tool work becomes invisible rather than
visibly wrong.

---

## What is still unanswered

| Question | Status |
|---|---|
| Aggregated tool namespacing | **Answered** — `{server}_{tool}`, single underscore |
| Is `x-mcp-servers` the scoping header | **Answered** — yes |
| Envelope for a blocked or failing MCP tool | **Undocumented.** Must be observed |
| Behaviour for an unknown name in `x-mcp-servers` | **Undocumented.** Must be observed |
