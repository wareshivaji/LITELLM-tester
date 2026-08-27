# TokenShield gateway surface — reference

Read from `~/Cloudgov/cloudgov-ai-gateway` source on **2026-08-26**, branch
`feature/per-key-mcp-tool-policy`. This is the contract the SDK is written against. When
something here turns out to be wrong, fix it here first, then fix the code.

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
