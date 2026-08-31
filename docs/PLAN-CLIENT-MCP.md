# Plan — test MCP the way a client would declare it

**Status: proposed, awaiting approval. Nothing here has been run.**

Scope, as set 2026-08-31: **`/v1/chat/completions`, `/v1/responses`, and the MCP support surface.**
Nothing else.

---

## 1. What was wrong with the previous approach

Phase 6 and the MCP suite test the gateway's **own** MCP endpoints — `GET /v1/mcp/servers`,
`GET /v1/mcp/tools`, JSON-RPC on `POST /v1/mcp`. Those are real and worth testing, but they are
**not what a customer sends**. A customer who has written against OpenAI or LiteLLM has never heard
of `/v1/mcp/servers`. They declare MCP the way their SDK lets them and expect it to work.

So the tests were asking "does the gateway's MCP surface behave?" when the question that predicts a
support ticket is "does MCP work for someone who only knows the OpenAI format?"

Both matter. They are different customers, and this plan separates them.

## 2. The reference, and why it is now checkable

Previously I had no LiteLLM and was relying on documented behaviour from memory. That has improved:
**the `openai` npm SDK is vendored in this repo** and its TypeScript definitions state the MCP
contract exactly. Read from `node_modules/openai@4.104.0/resources/responses/responses.d.ts`:

**The MCP tool declaration** — `/v1/responses`, in the `tools` array:

```ts
{ type: 'mcp',
  server_label: string,          // required
  server_url: string,            // required
  allowed_tools?: string[] | { tool_names?: string[] } | null,
  headers?: Record<string, string> | null,
  require_approval?: 'always' | 'never' | { … } | null }
```

**Output items** (in `output[]`), with these exact field names:

| `type` | Fields |
|---|---|
| `mcp_list_tools` | `id`, `server_label`, `tools[]`, `error?` |
| `mcp_call` | `id`, `name`, `arguments`, `server_label`, `output?`, `error?` |
| `mcp_approval_request` | `id`, `name`, `arguments`, `server_label` |
| `mcp_approval_response` | — |

**Streaming event names** — eight, exactly:

```
response.mcp_call.in_progress      response.mcp_list_tools.in_progress
response.mcp_call.arguments_delta  response.mcp_list_tools.completed
response.mcp_call.arguments_done   response.mcp_list_tools.failed
response.mcp_call.completed
response.mcp_call.failed
```

**And the finding that falls straight out of this:** our gateway emits **`mcp_tool_call`**, which is
none of the eight. A client using the OpenAI SDK's streaming parser sees an unrecognised event and
drops it — so brokered tool work becomes invisible, not wrong-looking. Verified against the SDK
types; unverified only in that the gateway side has not been re-read on this branch.

**CORRECTED 2026-08-31 — `/v1/chat/completions` and MCP.** I originally wrote that chat completions
has no MCP tool type, so transparent brokering was the only conformant design there. That was read
off the `openai` SDK's tool union, where the only type is `function`, and it is right about
*OpenAI's own* API and **wrong about LiteLLM**, which is the reference we follow.

Per <https://docs.litellm.ai/docs/mcp>, LiteLLM accepts a `{"type": "mcp"}` block in `tools` on
`/chat/completions`, and with `require_approval: "never"` it *"automatically executes the returned
tool calls and feeds the results back into the model before returning the assistant response"*. So
the declaration is explicit **and** the brokering is transparent — both, not either. Track 1 is
rewritten below accordingly. Full contract in [LITELLM_CONTRACT.md](LITELLM_CONTRACT.md).

**Still not verifiable here:** LiteLLM itself is not installed, so anything LiteLLM-specific stays
`reference: 'litellm'` and flagged. But note that the two references largely coincide: LiteLLM's
value proposition is OpenAI compatibility, so where the OpenAI SDK is definitive it is the stronger
reference anyway.

---

## 3. Track 1 — `/v1/chat/completions`

The premise: a client here can only ever send `function` tools. Everything MCP must be invisible or
expressed as a function.

| # | Test | Reference | Expectation | Spends | Needs a server |
|---|---|---|---|---|---|
| 1.1 | Send only `messages`, no `tools`, on a key with MCP entitlement | `litellm` | Either MCP tools are brokered transparently, or they are absent — but the reply must stay a legal chat completion either way | yes | yes |
| 1.2 | Inspect every `tool_calls[].type` the gateway ever emits | `openai` | Always `"function"`. Any other value breaks the client's discriminated union at parse time | yes | no |
| 1.3 | Client declares its own `function` tools while holding MCP entitlement | `openai` | Client tools are handed back for the client to execute, never silently executed by the gateway | yes | yes |
| 1.4 | One turn containing both a client tool call and an MCP tool call | `openai` | Both are represented; the turn completes. **Prod-confirmed deadlock here** — expected `not-implemented` | yes | yes |
| 1.5 | Streamed `tool_calls` deltas | `openai` | Each delta carries `index` — required to reassemble parallel calls. **Known missing** — expected `not-implemented` | yes | no |
| 1.6 | A blocked-by-policy tool that the client calls anyway | `cloudgov` | The refusal is an OpenAI-shaped error, **not** the flat `{"error":"string"}` envelope the guardrail path uses | yes | yes |

1.2 and 1.5 are runnable now. The rest need an MCP server.

## 4. Track 2 — `/v1/responses`

| # | Test | Reference | Expectation | Spends | Needs a server |
|---|---|---|---|---|---|
| 2.1 | `tools: [{type:'mcp', server_label, server_url}]` — the OpenAI-native declaration | `openai` | Accepted. A 400 on a legal OpenAI tool block is a hard compatibility break | yes | no¹ |
| 2.2 | `allowed_tools` as an array, then as `{tool_names:[…]}` | `openai` | Both accepted; the filter is honoured | yes | yes |
| 2.3 | `require_approval: 'always'` | `openai` | An `mcp_approval_request` output item, and the run pauses for it | yes | yes |
| 2.4 | `require_approval: 'never'` | `openai` | No approval item; the tool runs | yes | yes |
| 2.5 | Field names on `mcp_call` / `mcp_list_tools` output items | `openai` | Exactly as §2. A renamed or missing `server_label` silently breaks attribution | yes | yes |
| 2.6 | `headers: {authorization: …}` passed to the MCP server | `openai` | Forwarded — **and redacted** everywhere the lab records it | yes | yes |
| 2.7 | Shorthand `{role, content}` input item alongside tool items | `openai` | 200. Already tracked as `not-implemented` | no | no |

¹ 2.1 is testable immediately with any URL: the question is whether the gateway parses an
OpenAI-legal `type:'mcp'` tool block at all, which is independent of the server being reachable.

**2.6 is the one with a security edge.** `headers` is client-supplied credential material aimed at a
third-party server. Whatever the gateway does with it, this lab must not print it — `isSecretHeader`
already covers `x-mcp-*` but not an `authorization` nested inside a tool declaration in the request
body. That is a redaction gap in **my** code and I will fix it before running 2.6.

## 5. Track 3 — MCP support surface (gateway-native)

The existing four scenarios stay, **relabelled**: they test the surface a native MCP client (Cursor,
Claude Desktop, an MCP SDK) hits — `POST /v1/mcp` JSON-RPC and the listing endpoints. That is a real
customer, just not an OpenAI-format one. Keeping them separate stops a JSON-RPC result shape being
read as evidence about the OpenAI path.

| # | Test | Reference | Expectation |
|---|---|---|---|
| 3.1 | `tools/list` result shape | `mcp-spec` | `result.tools[]` present |
| 3.2 | `Mcp-Session-Id` assigned | `mcp-spec` | Header present — currently absent, `not-implemented` |
| 3.3 | Server listing envelope | `measured` | `servers` key present |
| 3.4 | Unknown JSON-RPC method | `mcp-spec` | `error.code` present |
| 3.5 | **New:** the same tool, once via `POST /v1/mcp` and once via a Responses `type:'mcp'` tool | `openai` | Same tool name and same result. A divergence means the two paths disagree about what a tool *is* |

3.5 is the bridge between the tracks, and the test most likely to find something real.

---

## 5b. The lab runs its own MCP server

**Added 2026-08-31, on the instruction not to depend on the AI gateway.**

Every test above was blocked on someone else supplying an org with a configured MCP server. That
made the feature this lab exists to test the one feature it could not test, and it meant every
expectation was ultimately measured against the gateway — which can only ever confirm the gateway
does what it does.

`packages/server/src/mockMcp.ts` serves JSON-RPC at `http://127.0.0.1:8787/mock-mcp`: `initialize`
(assigning `Mcp-Session-Id`), `tools/list`, `tools/call`, with two tools and switchable
`failCalls` / `failList` / `hang` modes. It is the **instrument**, not the subject — it records
exactly what reaches it.

What it now answers without any cooperating environment:

| Question | How |
|---|---|
| Single or double underscore in aggregated tool names | Register `lab_weather`, read back what the gateway advertises |
| Does the customer's gateway key leak to a third-party MCP server | Every inbound header is recorded and shape-checked for `cg-ak-`/`cg-mk-` |
| Does `x-mcp-{alias}-{header}` arrive, and under what name | Recorded header names |
| What a gateway does with a failing or hanging MCP server | Flip a mode and observe |
| Whether the tool actually ran | Its canned answer is deliberately absurd — *"raining upward at 3 degrees"*. If that string reaches the model's reply, the tool ran |

The leak check reports the **finding, never the value**: names and a verdict, with the key itself
absent from the output. Detection is by shape, not by comparison against a known secret, so it
catches a key the lab has never been told about. Nine unit tests cover it.

## 6. What I need before running

| Blocker | Blocks | Why |
|---|---|---|
| ~~An org/key with a working MCP server~~ | — | **No longer a blocker.** The lab runs its own — see §5b |
| Local gateway started | everything | Currently stopped. Starting it writes real spend to the shared prod stores, so that is your call |
| Approval to spend | the `spends: yes` rows | Cheapest model, `max_tokens` capped. 1.2/1.5/2.1/2.7 and all of Track 3 are free |

**Runnable with no MCP server and no approval beyond starting the gateway:** 1.2, 1.5, 2.1, 2.7,
3.1–3.4. That is the honest first slice, and 2.1 alone — does the gateway accept OpenAI's `type:'mcp'`
tool block — is the highest-value single question in the plan.

## 7. Build order

1. Fix the `headers` redaction gap (§4, my defect) — before anything sends a tool declaration.
2. Add `reference: 'openai'` MCP output-item and stream-event readers to `packages/client/src/mcp.ts`,
   alongside the existing `mcp_tool_call` reader rather than replacing it, so the two naming schemes
   can be compared rather than conflated.
3. Add the `openai-mcp` scenario suite (Tracks 1 and 2), separate from the relabelled `mcp` suite.
4. Extend the Tools & MCP page with an **OpenAI-native MCP** mode that emits `type:'mcp'`.
5. Run the free slice. Report. Then ask about the spending rows.
