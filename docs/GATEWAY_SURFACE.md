# TokenShield gateway surface — reference

Read from `~/Cloudgov/cloudgov-ai-gateway` source on **2026-08-26**, branch
`feature/per-key-mcp-tool-policy`. This is the contract the SDK is written against. When
something here turns out to be wrong, fix it here first, then fix the code.

> **Re-read 2026-08-31** against gateway branch `feature/responses-api-mcp-tools`. Routes are
> unchanged; the changes are behavioural. Now confirmed present: per-key MCP entitlement
> (`ScopeForKey`, `mcpAccess` ALL/NONE/SELECTED, failing **open** on an unrecognised mode), a
> two-state tool policy (`ALWAYS_ALLOW`/`BLOCK` — `NEED_APPROVAL` removed, though `ask` is still
> advertised on the wire), client-declared-tool hand-back on **both** chat and Responses, and
> `mcp_tool_call` frames emitted into streams. Org policy is a blacklist, key policy is an
> allow-list — the same stored value means different things at the two levels.
>
> **Branch caveat.** Phase-1 verification (2026-08-27) ran against a local gateway built from
> **`main`**, and everything below that was exercised — `/health`, `HEAD /`, `/api/v1/metrics`,
> `/v1/models`, the OpenAI error envelope — behaved identically. The parts sourced from the
> feature branch and **not** yet confirmed on main are the per-API-key MCP entitlement
> (`mcpAccess`, `ScopeForKey`) and per-key tool policy. Re-check those against whatever branch is
> checked out before relying on them in Phase 5/6.

Base URLs:

| Env | Base URL |
|---|---|
| Local | `http://localhost:4000` |
| Prod US | `https://gateway.cloudgov.ai` |
| Prod Mumbai | `https://gateway-mumbai.cloudgov.ai` |

Auth: `Authorization: Bearer cg-ak-…` **or** `x-api-key: cg-ak-…`. Both work on every `/v1`
route; clients in the wild use both, so the lab records which one was used.

---

## 1. Routes

### `/v1` — behind auth → ipallow → ratelimit → binding → budget → guardrail

Registered in `internal/proxy/handler.go: RegisterRoutes` and `internal/proxy/messages.go`.

**OpenAI surface**

| Method | Path |
|---|---|
| POST | `/v1/chat/completions` |
| POST | `/v1/completions` |
| POST | `/v1/embeddings` |
| POST | `/v1/responses` |
| GET | `/v1/models` |
| POST | `/v1/tokens/count` |
| POST | `/v1/moderations` |

**Anthropic surface** — same middleware, *different error envelope*

| Method | Path |
|---|---|
| POST | `/v1/messages` |
| POST | `/v1/messages/count_tokens` |

**Files**

`POST /v1/files` · `GET /v1/files` · `GET /v1/files/:id` · `GET /v1/files/:id/content` ·
`DELETE /v1/files/:id`

**Batches**

`POST /v1/batches` · `GET /v1/batches` · `GET /v1/batches/:id` · `POST /v1/batches/:id/cancel`

**MCP**

`GET /v1/mcp/servers` · `POST /v1/mcp/servers/test` · `GET /v1/mcp/tools` ·
`POST /v1/mcp/tools/call` · `POST /v1/mcp` (aggregate, Streamable HTTP) ·
`POST /v1/mcp/:server/mcp` · `DELETE` on both · `POST /v1/mcp/test` · `POST /v1/mcp/request`

### Unauthenticated / ops

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{"status":"healthy","service":"cloudgov-ai-gateway"}` |
| HEAD | `/` | connectivity probe Claude clients send at startup; answers 200 |
| GET | `/docs` | API documentation page |
| GET | `/api/v1/metrics` | in-process counters — RPM, latency, error rates |

### Management — `x-management-key: cg-mk-…`

`POST /api/v1/management/api-keys` mints a `cg-ak-` key. Body: `name` (required),
`budget_limit_usd`, `budget_period` (`daily|weekly|monthly|quarterly|yearly`), `expires_in_days`,
`allowed_models[]`, `providers[]` (**by name**, there is no credential-id field),
`ip_allow_list[]`, `alert_emails[]`, `application`, `purpose`. Returns 201 with the raw key,
shown once.

### Admin — `x-admin-key`

`GET /api/v1/admin/cache` · `POST /api/v1/admin/cache/clear` · `…/evict` · `…/refresh` ·
`…/refresh/:orgID` · `POST /api/v1/admin/mcp/test`

---

## 2. Response signal

Headers the gateway sets. **A browser cannot read any of these** — `AllowOrigins` is `*` but
`ExposeHeaders` is never set (`internal/server/server.go`), so only the six CORS-safelisted
response headers reach page JavaScript. This is why the lab has a backend.

| Header | Meaning |
|---|---|
| `X-Request-ID` | per-request correlation id; the join key into ClickHouse usage rows and the Traces page |
| `X-Organization-ID` | resolved org |
| `X-Budget-{Limit,Spend,Warning}` | request-scope budget |
| `X-Key-Budget-*`, `X-User-Budget-*`, `X-Group-Budget-*` | the other three budget scopes |
| `Retry-After` | seconds, on rate-limit rejections |
| `x-should-retry` | `false` on spend rejections, so Claude clients stop retrying |
| `x-tokenshield-guardrail-ms` | guardrail check cost |
| `Mcp-Session-Id` | Streamable-HTTP MCP session |

---

## 3. Error envelopes — three of them

Which one comes back **is itself a compatibility finding**, so the SDK records it separately
from the verdict.

**OpenAI-shaped** (`internal/apierror/openai.go`) — most of `/v1`:

```json
{ "error": { "message": "…", "type": "authentication_error", "param": null, "code": "invalid_api_key" } }
```

Budget rejections add `spend_usd`, `limit_usd`, `period`, `budget_name`, `cloud_provider`,
`cloud_account_id` inside the error object.

Type constants: `insufficient_quota`, `permission_error`, `invalid_request_error`,
`authentication_error`, `not_found_error`, `rate_limit_error`, `api_error`.

**Anthropic-shaped** (`internal/apierror/anthropic.go`) — on `/v1/messages*`:

```json
{ "type": "error", "error": { "type": "billing_error", "message": "…", "budget_name": "…" } }
```

**Flat** — the legacy shape OpenAI SDKs cannot parse. Still emitted by handlers that predate
`apierror`, and by two paths that matter:

```json
{ "error": "guardrail_violation", "message": "Request blocked by content guardrails",
  "guardrailName": "…", "violations": [ … ], "overheadMs": 3 }
```

```json
{ "error": "rate limit exceeded", "retry_after_seconds": 54 }
```

---

## 4. Ambiguities the classifier resolves

These cost real debugging time before; `packages/client/src/classify.ts` encodes them.

| Looks like | Actually | Tell |
|---|---|---|
| 429 | spend cap | `type: insufficient_quota` / `billing_error`, or `budget_name` present |
| 429 | per-minute RPM limiter (default 60) | flat `{"error":"rate limit exceeded","retry_after_seconds":N}` |
| 403 | key has no credential for that provider | `no_credential_for_provider` |
| 403 | `allowedModels` gate, rejected *before* any provider call | `model_not_allowed_for_key` |
| **400** | **guardrail block** | flat envelope with `error: "guardrail_violation"` — note it is 400, not 403 |
| 400 | genuinely malformed request | no guardrail marker |

---

## 5. Feature map — what the console must be able to trigger

| Gateway package | Feature | How the client sees it |
|---|---|---|
| `auth` | `cg-ak-` key, allowedModels | 401 / 403 `model_not_allowed_for_key` |
| `ipallow` | per-key IP/CIDR allowlist | 403 before any provider call |
| `ratelimit` | per-key + per-org RPM | flat 429 + `retry_after_seconds` |
| `binding` | per-key provider/account budgets | 403 `no_credential_for_provider`, spend attribution |
| `budget` | key/user/group/org caps + warnings | `X-*-Budget-*` headers, then 429 |
| `guardrail` | prompt injection, custom code, PII | 400 flat envelope, `x-tokenshield-guardrail-ms`; mid-stream blocks |
| `routing` / `smartrouting` | alias → provider; tier classifier | which model actually answered |
| `precache` / `cache` | response + config caching | latency delta; staleness after a config edit |
| `resilience` | retry, failover, circuit breaker | two usage rows for one request; model swap |
| `mcp` | server registry, tool loop, per-key policy | tools advertised vs refused |
| `filestore` | Files API | upload, then reference in a chat request |
| `tracing` | trace / span / session id, `turn_count` | `X-Request-ID` as the join key |
| `billing` | usage rows into ClickHouse | spend moves |

---

## 5b. What the MCP/Responses expectations are measured against

The gateway's Responses-API and MCP work is **unfinished**, so encoding its current behaviour as
the contract would freeze an in-progress implementation into a standard. The expectations are
therefore written against external references, and each scenario names which one it used
(`reference` on the row and in the exported report). See AD-30.

**Solid ground — published contracts:**

| Reference | Used for |
|---|---|
| MCP specification | JSON-RPC framing on `POST /v1/mcp`: `tools/list` returns `result.tools[]`; an unknown method returns an `error` object with a numeric `code`, not an HTTP failure; under Streamable HTTP a server that wants a session assigns `Mcp-Session-Id` and the client echoes it |
| OpenAI Responses API | Tool continuation: the documented form sends the prior turn's items back in `input[]` keyed by `call_id`, alongside the user turn in the shorthand `{role, content}` form |

**No external reference exists — `reference: 'cloudgov'`:**

> **CORRECTED 2026-09-01 from LiteLLM source.** The claim below — that per-key tool blocking has no
> LiteLLM equivalent — is **wrong**. LiteLLM has `mcp_tool_permissions` at key and team level, both
> `allowed_tools` and `disallowed_tools`, and intersects team with key. See
> [LITELLM_CONTRACT.md](LITELLM_CONTRACT.md) §5. What remains CloudGov-only is the single policy
> enum read two different ways at org and key level, and the fail-open default.

Per-key tool blocking has no LiteLLM equivalent, so there is no outside contract to measure it
against, and writing one would mean inventing a reference. Decided 2026-08-31: it is not compared
to LiteLLM at all.

What is testable from the client side is a narrower thing — the **compatibility invariant**:
enforcing the policy must not change the shape of what a client sends or parses. The request format
is the plain OpenAI wire format either way; what varies is which tools the gateway runs and what it
records, and that accounting is monitored on the gateway rather than asserted from here.

On the **advertising path** the invariant holds by construction: a blocked tool is not listed, the
client never calls it, and nothing about the wire changes. The **one exception** is a client that
calls a blocked tool anyway — from a stale tool list, or by declaring the name itself. That refusal
*is* client-visible, so its envelope is a genuine contract question, and it is the third open point
below.

**Not verified here — needs confirmation before it is treated as authoritative:**

LiteLLM is the stated compatibility target (`tokenshield-compat-tests` measures "what an
OpenAI/LiteLLM client expects"), but **no LiteLLM source or package is installed on this machine** —
`litellm` is not importable and there is no local checkout. Anything marked `reference: 'litellm'`
is therefore from documented behaviour rather than from something checked, and is flagged as such in
the UI tooltip and the report legend. No scenario currently relies on a LiteLLM-specific claim: the
four MCP scenarios are all `mcp-spec`, and the Responses pair is `openai`.

The remaining open points are the ones that can change **what a client sends or parses** — the only
category where a LiteLLM difference would actually reach a customer:

- whether aggregated tool names are namespaced, and with what separator
- whether `x-mcp-servers` is the scoping header and how an unknown server name is treated
- whether calling a blocked or failing MCP tool surfaces as a tool result carrying an error, or as
  a request failure — the client-visible half of per-key tool policy

Each needs an org with a working MCP server to settle; `/v1/mcp/servers` returns an empty list on
the keys available here.

---

## 5c. Live run, Prod US, 2026-09-02

Two prompt cases, `/v1/responses`, `bedrock-claude-haiku-4.5`, key
`Prod level tool blocking` (org `69d35779ed0a3a6c61c8719a`). Both passed.

**Key-driven brokering is confirmed.** Neither request carried a `tools` field — verified by dry run
before sending. The gateway still offered 7 tools and ran them. So entitlement on the key is the
whole trigger, and a client cannot opt out of governance, only out of tools. The inverse of LiteLLM,
where a caller who omits the MCP block gets no tools and no governance either.

**A BLOCK is now provable.** The offered list came back as exactly:

```
hf_whoami, hub_repo_details, hub_repo_search, microsoft_code_sample_search,
microsoft_docs_search, migrate_pages_to_workers_guide, search_cloudflare_documentation
```

Seven of the key's nine policied tools. **`hf_fs` and `microsoft_docs_fetch` are absent** — the two
`BLOCK` entries, withheld rather than refused. Asked for both blocked capabilities directly, the
model degraded exactly as predicted: it ran `microsoft_docs_search` instead of `microsoft_docs_fetch`
and `hub_repo_details` instead of `hf_fs`, and wrote a plausible answer around the gap. Reading that
prose tells you nothing; the offered list is the evidence.

**Cross-server attribution works, even though the listing label does not.** One request brokered two
tools on two servers, and each `mcp_call` carried the correct distinct `server_label` — `MS Learn`
and `HuggingFace`. So per-call attribution is sound; it is only `mcp_list_tools.server_label` that
comma-joins every server into one unusable string.

### NEW: tool output truncates at ~4,032 characters, not the documented 120,000

`microsoft_docs_search` output was cut at **4,032 characters** with the gateway's own marker. The
walkthrough (§5.4) documents the cap as **120,000** — so it truncates at about **3.4%** of the
stated limit, a 30× discrepancy, and the **model** saw the truncated result.

The number points at a cause. Walkthrough §2.7 says the *chat* SSE path truncates a tool preview at
**4,000** characters. 4,032 is that number plus a marker, on the **Responses** path, where the
preview truncation should not apply at all. So the likely fault is the chat preview cap leaking into
the Responses transparency item — and worse, being applied to the copy the model is fed rather than
only to the copy the client is shown.

Impact is direct: a docs-search tool returns 10 chunks of up to 500 tokens each by its own
description, and the model is answering from roughly the first eighth of that. Every answer built on
a long tool result is quietly degraded.

Reproduce: `mcp-block-is-provable` on `/v1/responses`, then read `output_truncated` in the run
report, or look for `[... truncated by the gateway]` in the `mcp_call` output.

---

## 5d. Full prompt sweep, Prod US, 2026-09-02

All 11 cases, both surfaces, `bedrock-claude-haiku-4.5`. **5 clean, 4 findings, 2 already covered
in 5c.** The five clean ones — plain answer, system instruction, JSON output, a client tool offered
back, a tool available but not forced — agreed across both surfaces every time. That baseline is
what makes the rest interpretable.

### A. The gateway hands its own MCP tool back to the client, under the wire name

The mixed-ownership case declared **one** client tool, `get_weather`. The client got back **two**:

```
client tool calls = ['get_weather', 'huggingface__hub_repo_search']
```

`huggingface__hub_repo_search` is the **wire name** of a tool the gateway brokers. The client never
declared it and has no implementation for it.

Handing the whole turn back is documented and deliberate (walkthrough §2.5: *"the whole turn is
handed back rather than half-executed"*) and the gateway tool correctly did **not** run. The problem
is the consequence: a conforming OpenAI client reads `tool_calls`, must execute each one, and cannot
execute this. It either invents a result, drops the call and breaks the conversation, or stops. This
is the prod-confirmed mixed-turn deadlock, seen from the client side.

**It also corrects an earlier claim of mine.** I wrote on 2026-09-01 that the wire name appears in
no client-visible artifact and no API response — only in the model's own call. It appears here, in a
handed-back `tool_calls` entry. And the separator is confirmed as `__`, diverging from LiteLLM's
env-configurable `-`.

### B. `/v1/chat/completions` brokers tools and reports nothing at all

The cross-server case on chat: **200, 10.5s, zero `mcp_call`, zero `mcp_list_tools`** — and an answer
containing real Hugging Face data, including `hf.co` links no model invents. So the tools **ran**;
the client simply has no record of it.

The same request on Responses brokered both tools with correct distinct `server_label`s
(`HuggingFace`, `Cloudflare docs`), confirming cross-server aggregation and per-call attribution.

Appendix C.2 states transparency items are Responses-only, so this is documented rather than a
surprise — but the live consequence is worth stating plainly: **on chat completions, brokered tool
work is invisible.** Ten seconds of latency, real external calls, third-party data in the answer,
and nothing in the response says a tool was involved. A customer cannot audit it, attribute it, or
bill it back.

### C. A prompt naming an unentitled server returns 502 on chat, 200 on Responses

*"Use Context7 to look up React useEffect documentation"* — Context7 is not in this key's
`serverIds`.

| Surface | Result |
|---|---|
| chat completions | **502** after 5.4s |
| responses | **200**, model replies that it has no such tool |

A 502 is not a legitimate answer to that prompt, and the Responses path proves it: same key, same
prompt, correct graceful reply. Reproducible from `mcp-out-of-scope-server`.

Also confirmed here: **no `mcp_list_tools` was emitted on the 200**, because no tool ran. So the
listing really is conditional on execution, and the lab's `withholdsTool` correctly reported *cannot
tell* rather than passing — the guard doing its job on live data.

### D. A declared `type:"mcp"` block is refused with 403, not the documented 400

Both surfaces returned **403**, in 267ms on Responses — fast enough to be pre-provider. The
walkthrough says *"a block naming nothing reachable is a 400 rather than a silent no-op."* The code
says 403.

The outcome that matters is right: it is **refused**, not silently dropped. A 200 would be far worse,
leaving a client believing it had scoped a request when the block was discarded. But 400 and 403
mean different things to a client — one says "your request is malformed", the other "you may not do
this" — and only one of them is documented.

The lab expectation was wrong here, not the gateway. Fixed with a `refusedWith: [400, 403]` marker
that checks the status and skips content checks entirely, since running them against a refusal body
reports the same defect several times and buries the real one.

---

## 6. Local-run notes

- Gateway autoloads `.env` **at startup only** (godotenv). Add vars before starting.
- `MCP_TEST_ALLOW_HOSTS` is **default-deny** — empty rejects every host and presents as "MCP is
  broken". Locally you want `MCP_TEST_ALLOW_HOSTS=*` and `MCP_TEST_ALLOW_LOOPBACK=true`.
- `API_KEY_CACHE_TTL_SECONDS` and `CREDENTIAL_CACHE_TTL_SECONDS` both default to 900s, so policy
  edits take up to 15 minutes to bite unless lowered or the gateway is restarted.
- `go run ./cmd/gateway` spawns a child `gateway.exe`; killing the parent can leave the child
  bound to :4000. Only one process can bind it, and requests land on whichever won.
- A local gateway connects to the **shared prod** Mongo and ClickHouse. Prod keys resolve
  locally, and spend written locally is real spend.
- `migrations/` is documentation only — there is no migration runner. Several ClickHouse columns
  (`tool_calls`, `finish_reason`, `trace_id`, `session_id`, `turn_count`) were applied by hand.
