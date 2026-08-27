# PLAN — TokenShield Client SDK + Lab Console

> **Status:** plan only, nothing built. Created 2026-08-26.
> **Repo to create:** `~/Cloudgov/tokenshield-client-sdk` (new, standalone, its own git repo)
> **Moves to** `docs/PLAN.md` inside that repo at the end of Phase 1.
> **Execution rule for this project:** one phase at a time. Finish a phase, stop, wait for
> "start next". No phase spills into the next.

---

## 1. What we are building and why

TokenShield (`~/Cloudgov/cloudgov-ai-gateway`) is the Go/Echo OpenAI-compatible AI gateway.
Today it is exercised two ways:

| Existing | What it is | What it can't do |
|---|---|---|
| `~/Cloudgov/tokenshield-compat-tests` | Python scripts + pytest, results into `.txt`/`.xlsx` | no UI, no live view, per-run env-var traps, results are static files |
| `cloudgov-ui` TokenShield console | the **provider/admin** side (keys, budgets, guardrails, traces) | it configures the gateway; it is not a customer app |

Missing piece: **the customer side.** A real integrator's app — with a UI — that talks to
TokenShield over HTTP exactly the way a paying customer's product does, and shows us
everything the gateway sent back.

So this repo is two things in one:

1. **`@tokenshield/client`** — a real client SDK for TokenShield (the thing a customer would
   import), which records every exchange in full fidelity.
2. **Lab Console** — a backend + React UI on top of that SDK, so any gateway behaviour can be
   driven and *seen* without writing a script.

**Non-goal:** replacing the Python suite. That stays as the raw conformance/regression bench.
This is the interactive, demo-able, "be the customer" tool.

---

## 2. Ground truth — the gateway surface (verified from code, 2026-08-26)

Base URLs: local `http://localhost:4000`, prod US `https://gateway.cloudgov.ai`,
prod Mumbai `https://gateway-mumbai.cloudgov.ai`.
Auth: `Authorization: Bearer cg-ak-…` **or** `x-api-key: cg-ak-…` (both work).

### 2.1 Endpoints the SDK must cover

**Inference / OpenAI surface** (`/v1`, auth + ipallow + ratelimit + binding + budget + guardrail middleware):
`POST /chat/completions`, `POST /completions`, `POST /embeddings`, `POST /responses`,
`GET /models`, `POST /tokens/count`, `POST /moderations`

**Anthropic surface** (same `/v1` group, different error envelope):
`POST /messages`, `POST /messages/count_tokens`

**Files:** `POST /files`, `GET /files`, `GET /files/:id`, `GET /files/:id/content`, `DELETE /files/:id`
**Batches:** `POST /batches`, `GET /batches`, `GET /batches/:id`, `POST /batches/:id/cancel`

**MCP:** `GET /mcp/servers`, `POST /mcp/servers/test`, `GET /mcp/tools`, `POST /mcp/tools/call`,
`POST /mcp` (aggregate, Streamable HTTP), `POST /mcp/:server/mcp`, `DELETE` on both,
`POST /mcp/test`, `POST /mcp/request`

**Unauthenticated / ops:** `GET /health`, `HEAD /`, `GET /docs`, `GET /api/v1/metrics`
**Management (x-management-key, `cg-mk-…`):** `POST /api/v1/management/api-keys` — mints
`cg-ak-` keys with `budget_limit_usd`, `budget_period`, `expires_in_days`, `allowed_models`,
`providers[]`, `ip_allow_list[]`, `alert_emails[]`, `application`, `purpose`.
**Admin (x-admin-key):** `/api/v1/admin/cache*` — cache list/clear/evict/refresh.

### 2.2 Response signal the SDK must capture

Headers the gateway sets — these are half the test signal:
`X-Request-ID`, `X-Organization-ID`, `Retry-After`, `x-should-retry`,
`x-tokenshield-guardrail-ms`, `Mcp-Session-Id`,
`X-Budget-{Limit,Spend,Warning}` and the `X-Key-*`, `X-User-*`, `X-Group-*` variants.

Three different error envelopes — **which one came back is itself a finding**:
- OpenAI-shaped `{"error":{message,type,param,code, +spend_usd/limit_usd/period/budget_name}}`
- Anthropic-shaped `{"type":"error","error":{type,message,…}}` on `/v1/messages*`
- legacy flat `{"error":"…"}` from some handlers (LANDMINE-1 — still present in places)

### 2.3 Gateway features → what the console must be able to trigger

| Gateway package | Feature | How the client sees it |
|---|---|---|
| `auth` | `cg-ak-` key, allowedModels | 401 / 403 `model_not_allowed_for_key` |
| `ipallow` | per-key IP/CIDR allowlist | 403 before any provider call |
| `ratelimit` | per-key + per-org RPM (default 60) | flat 429 + `retry_after_seconds` |
| `binding` | per-key provider/account budgets | 403 `no_credential_for_provider`, attribution |
| `budget` | key/user/group/org caps, warnings | `X-*-Budget-*` headers, 429 `insufficient_quota` + `budget_name` |
| `guardrail` | prompt-injection, custom-code, PII | block response + `x-tokenshield-guardrail-ms`; mid-stream blocks |
| `routing` / `smartrouting` | model alias → provider; tier classifier | which model actually answered |
| `precache` / `cache` | response + config caching | latency delta, staleness after a config edit |
| `resilience` | retry, failover, circuit breaker | 2 usage rows per request; model swap |
| `mcp` | server registry, tool loop, per-key policy | tools advertised vs refused |
| `filestore` | Files API | upload → reference in a chat request |
| `tracing` | trace/span/session ids, turn_count | `X-Request-ID` join key into the Traces page |
| `billing` | usage rows to ClickHouse | spend moves; visible in the console UI |

---

## 3. Architecture

```
~/Cloudgov/tokenshield-client-sdk/
├─ package.json                # npm workspaces root
├─ .env.example                # documented; .env.local is gitignored
├─ packages/
│  ├─ client/                  # @tokenshield/client   — the SDK (TypeScript)
│  │  ├─ src/transport/        # fetch wrapper, Exchange recorder, SSE parser, redaction
│  │  ├─ src/surfaces/         # chat, completions, embeddings, responses, messages,
│  │  │                        #   files, batches, tokens, moderations, mcp, models
│  │  ├─ src/management/       # cg-mk- key minting
│  │  ├─ src/adapters/         # stock `openai` + `@anthropic-ai/sdk` with a teed fetch
│  │  └─ src/classify/         # error/429/403 classifier + landmine registry
│  ├─ server/                  # lab backend (Fastify + zod), binds 127.0.0.1 only
│  └─ web/                     # React + Vite + TS console
├─ scenarios/                  # declarative suites (TS/JSON), versioned
└─ out/                        # gitignored: exported run reports
```

### 3.1 Why a backend at all (we said "no DB", not "no backend")

Four hard reasons, not preference:

1. **The browser cannot read the headers we care about.** The gateway sets
   `AllowOrigins: *` but **never sets `ExposeHeaders`** (`internal/server/server.go:66`), so
   CORS hides everything except the safelisted six. `X-Request-ID`, all `X-Budget-*`,
   `x-should-retry`, `Retry-After`, `x-tokenshield-guardrail-ms` are **invisible to JS**.
   A server-side hop is the only way to see them.
2. **The key must never reach the browser.** UI works with key *aliases*; raw `cg-ak-`/`cg-mk-`
   values live only in the backend's memory.
3. **Real-SDK mimicry is a Node concern.** `openai` and `@anthropic-ai/sdk` are meant to run
   server-side; running them in a browser is exactly what customers don't do.
4. **Burst/loop work belongs off the UI thread** — RPM tests, budget-exhaustion loops,
   scenario suites, retries.

### 3.2 Storage policy — explicit

- **No database. No Mongo, no ClickHouse, no SQLite, no Redis.**
- Run history = an in-memory ring buffer in the backend (cap ~200 exchanges, configurable).
  Restart the backend and it's gone. That is intended.
- The only disk writes: (a) `.env.local` that *you* write, (b) `out/*.json|md|csv` when you
  press Export. Both gitignored.
- Keys are never written to disk by the app, never logged, and are masked
  (`cg-ak-abcd…wxyz`) in every UI surface and every export.

### 3.3 The core type — `Exchange`

Everything the SDK does produces one of these; the UI is a viewer for it.

```ts
type Exchange = {
  id: string; profile: string; surface: string; mode: 'raw' | 'openai-sdk' | 'anthropic-sdk';
  request:  { method: string; url: string; headers: Record<string,string>; body?: unknown };
  response: { status: number; headers: Record<string,string>; body?: unknown;
              chunks?: { t: number; raw: string; parsed?: unknown }[] };
  timings:  { ttfbMs: number; totalMs: number; guardrailMs?: number };
  gateway:  { requestId?: string; orgId?: string; budget?: BudgetSnapshot; retryAfter?: number };
  verdict?: { kind: 'ok'|'budget'|'ratelimit'|'guardrail'|'model-denied'|'no-credential'
                   |'auth'|'tool-policy'|'landmine'|'unknown';
              envelope: 'openai'|'anthropic'|'flat'; detail: string; landmineId?: string };
};
```

`verdict` is the point of the whole thing: the classifier turns an opaque failure into a named
cause, using the traps we already paid for (§6).

---

## 4. Phases

Each phase: one deliverable, one way to verify it, then **stop**.

### Phase 1 — Scaffold + Connect (small on purpose)
- `git init`, npm workspaces, TS configs, `.gitignore` (`.env*`, `out/`, `node_modules`), ESLint/Prettier.
- `.env.example` + `.env.local` loader. Profiles: `local`, `prod-us`, `prod-mumbai`.
- Backend skeleton (Fastify, 127.0.0.1, `/api/health`), web skeleton (Vite + React + TS).
- SDK: transport + `Exchange` recorder + redaction + `GET /health`, `GET /v1/models`, `GET /api/v1/metrics`.
- **UI: Connect page** — pick profile, pick key alias, Preflight button → gateway reachable,
  key valid, the model list this key is allowed, gateway metrics snapshot.
- **Verify:** `npm run dev`, Connect page shows green against a locally running gateway on :4000
  *and* against prod with a real key; the models list matches that key's `allowedModels`.
- Move this plan to `docs/PLAN.md`; write `README.md` (run instructions) and `docs/GATEWAY_SURFACE.md`
  (the §2 inventory, as living reference).

### Phase 2 — SDK core + Playground (non-streaming) + Inspector
- Surfaces: chat/completions, completions, embeddings, responses, messages, messages/count_tokens,
  tokens/count, moderations.
- Full header capture, TTFB/total timings, error-envelope detection, classifier v1.
- Backend `POST /api/exchange`, in-memory ring buffer, `GET /api/runs`, `GET /api/runs/:id`.
- **UI: Playground** — surface tab, model picker (from `/v1/models`), params panel incl. the
  edge-case knobs (`stop` as string *or* array, `content` as array, `n`, `logprobs`, `seed`,
  penalties, `response_format`, `tool_choice`), send, response pane.
- **UI: Inspector** — request headers/body, response headers table (budget headers broken out),
  raw body, verdict chip, copy-as-curl.
- **Verify:** reproduce LANDMINE-1/2/3 from the UI and see the verdict name each one; a normal
  chat call returns text and shows `X-Request-ID` + budget headers.

### Phase 3 — Streaming
- SSE parser in the SDK: per-chunk timestamps, `[DONE]` handling, malformed-frame tolerance.
- Backend SSE relay: gateway stream → record → re-emit to UI (`GET /api/stream/:id`).
- **UI:** live token stream + a chunk timeline table (t, delta, finish_reason, empty `id`/`created:0`
  anomalies flagged), inter-chunk gap chart.
- Cover: `stream_options.include_usage`, mid-stream guardrail block, mid-stream error frame,
  client abort (does the gateway still bill?).
- **Verify:** stream a long completion; timeline renders; a guardrail phrase mid-stream shows
  where the stream was cut.

### Phase 4 — Real vendor SDK adapters
- `openai` and `@anthropic-ai/sdk` pointed at the gateway with a custom `fetch` that tees into
  the same recorder — so vendor-SDK calls produce identical `Exchange` records.
- **UI:** a `raw HTTP | openai-sdk | anthropic-sdk` toggle on the Playground, and a diff view
  when the same request is sent both ways (what the vendor SDK refuses to send, what it retries,
  how it parses our error envelopes).
- **Verify:** same prompt, three modes, side-by-side; the vendor SDK's retry-on-429 behaviour is
  visible in the exchange list.

### Phase 5 — Governance lab + Keys page
- **Keys page:** mint disposable `cg-ak-` keys via `x-management-key` — name `sdk-lab-<purpose>`,
  tiny budget, short expiry, explicit `allowed_models` / `providers` / `ip_allow_list` — and use
  one immediately in the Playground. Raw value shown once, held in memory, masked everywhere else.
- **Governance page:** one card per gate, each with a "trip it" button and an explanation of what
  came back — guardrail, key budget, group budget, RPM limiter, allowedModels, IP allowlist,
  provider binding, tool policy.
- Budget widget: `X-*-Budget-Spend/Limit/Warning` over successive calls until the 429.
- **Verify:** mint a $0.02 key, exhaust it, see the warning headers climb then the
  `insufficient_quota` 429 with `budget_name` — and the console names it correctly vs an RPM 429.

### Phase 6 — Tools & MCP
- Client-declared `tools[]` (chat `function.name` / `custom.name`; Responses `name` / `type`),
  the full tool-call round trip, parallel tool calls, `tool_choice` (incl. the named-tool case
  that doesn't actually restrict), STRIP vs REJECT tool-policy behaviour.
- MCP: `GET /mcp/servers`, `GET /mcp/tools`, `POST /mcp/servers/test`, `POST /mcp/tools/call`,
  and the Streamable-HTTP `POST /v1/mcp` aggregate + per-server endpoints with `Mcp-Session-Id`.
- **UI:** tool definition editor, a turn-by-turn tool-loop timeline, MCP server/tool browser,
  "offered vs advertised vs refused" comparison.
- **Verify:** a two-tool turn resolves; a BLOCK-policy tool is refused; the client-declared-tool
  swallow bug (`internal/mcp/loop.go resolveCall`) is reproducible from the UI.

### Phase 7 — Scenarios, Compare, reports
- Declarative scenarios in `scenarios/`: `{id, surface, request, expect{status, verdict, envelope,
  headers, bodyPath}}`, plus a **landmine registry** mirroring the Python suite's xfail list, so a
  fixed landmine flips from "known" to "FIXED" in the UI.
- Runner with pacing (stay under RPM), concurrency cap, and live progress over SSE.
- **UI: Scenarios** — pass/fail/known-landmine matrix, drill into any row's full exchange.
- **UI: Compare** — same request against two profiles or two models; diff status, headers,
  latency, body.
- Export to `out/` as JSON + Markdown + CSV, each report stamping profile, base URL, key alias,
  model, gateway commit if reachable.
- **Verify:** a suite runs end to end against local and prod, and the exported report is
  reviewable evidence.

### Phase 8 — Hardening + handover
- `README.md` (quickstart), `docs/RUNBOOK.md` (how to trip each gate, the traps in §6),
  `docs/ARCHITECTURE.md`.
- Unit tests on the pure parts: SSE parser, classifier, redaction, scenario assertions.
- npm scripts (`dev`, `build`, `lint`, `test`), optional Dockerfile.
- CloudGov BP checklist pass (§8 of the best-practices doc), esp. BP-001 null-safety in TS
  (`?.`/`??`, no `any`) and secret hygiene.
- **Verify:** clean clone → `npm i` → `npm run dev` works from the README alone.

---

## 5. Decisions taken (say so now if you disagree)

| # | Decision | Why |
|---|---|---|
| D1 | **TypeScript everywhere** (SDK + backend + UI) | one language across three layers; shared `Exchange` types; the two vendor SDKs customers actually use are first-class in Node; you already work in React |
| D2 | Python suite untouched | it is the raw conformance bench; this is the interactive client. Two tools, two jobs |
| D3 | Fastify + zod backend, Vite + React UI, Tailwind | small, boring, fast; no heavy UI kit |
| D4 | Bind backend to `127.0.0.1`, no auth on the console | local dev tool. Never deploy it |
| D5 | Ring buffer + explicit export; **no DB** | your constraint. Durability only when a report is wanted |
| D6 | SDK keeps a **raw** transport as the primary path | typed vendor SDKs refuse to send the malformed payloads that expose gateway bugs |
| D7 | Keys by alias in the UI, raw values backend-only, masked in exports | `RUNBOOK.md` in the compat-tests repo has ~14 live keys in plaintext; this repo will not repeat that |
| D8 | Every run stamps profile + base URL + key alias in the UI header | the single most expensive class of past bug was "which gateway did that actually hit?" |

---

## 6. Traps to design around (paid for already — don't re-learn)

1. **Which target did this hit?** A stale env var once sent a whole run to prod unnoticed.
   → One config source; the resolved base URL + key alias are printed on every exchange and
   every export, not just at startup.
2. **Env-var precedence.** In the Python suite `TS_KEY` silently overrides `TOKENSHIELD_API_KEY`
   → blanket 403s. → No layered key vars here: profiles are named objects, and the UI shows which
   one is live.
3. **Two different 429s.** `insufficient_quota` + `budget_name` = budget cap; flat
   `{"error":"rate limit exceeded","retry_after_seconds":N}` = the RPM limiter (default 60/min).
   → Classifier separates them by body shape; the UI never says "rate limited" without saying which.
4. **Two different 403s.** `no_credential_for_provider` (key has no cred for that provider) vs
   `model_not_allowed_for_key` (allowedModels gate, rejected pre-provider). → Named separately.
5. **The scenario runner will trip the RPM limiter** — the embeddings suite fires ~11 provider
   calls per model. → Built-in pacing + concurrency cap + a "run the model under test first in a
   fresh window" note.
6. **Cache TTLs lie to you.** `API_KEY_CACHE_TTL_SECONDS` and `CREDENTIAL_CACHE_TTL_SECONDS`
   default to 900s, so a policy change takes up to 15 min to bite. → When a governance assertion
   fails, the UI shows a "config may be cached up to Ns" hint and links the admin cache-refresh
   endpoint.
7. **A local gateway talks to prod Mongo/ClickHouse.** Minted keys are real, spend is real, usage
   rows are real. → Mint only `sdk-lab-*` keys with tiny budgets and short expiry; the Keys page
   says this in plain words.
8. **Multiple gateway processes on :4000.** `go run` spawns a child; killing the parent can leave
   it bound, so requests land on an unknown build. → Preflight reports gateway PID/uptime/version
   where obtainable, and the RUNBOOK carries the clean-slate command.
9. **MCP is default-deny locally.** `MCP_TEST_ALLOW_HOSTS` empty rejects every host and looks like
   "MCP is broken". → Phase 6 preflight checks this and says so.
10. **Streaming blocks differ per surface.** `/v1/messages` `relaySSE` writes bytes *before*
    observing, chat checks before writing, Responses observes → writes → checks. → Streaming
    assertions are per-surface, never shared.
11. **CORS hides the headers.** No `ExposeHeaders` on the gateway → never let the browser call the
    gateway directly, even though `AllowOrigins:*` makes it look possible.

---

## 7. Out of scope

Writing to any CloudGov datastore. Changing the gateway (findings get filed, not patched from
here — a fix is a separate branch in `cloudgov-ai-gateway`). Deploying this console anywhere.
Load testing (`test/loadtest/` already exists in the gateway repo). Replacing
`cloudgov-ui`'s admin console. Real end-user auth/multi-tenancy in the lab.

---

## 8. Open question before Phase 1

**D1 (TypeScript everywhere) is the one call worth confirming**, since it decides all eight
phases. The alternative is Python + FastAPI for the SDK/backend — it would reuse the compat-tests
patterns and `_util.py`'s knowledge, but splits the stack from the React UI and makes the vendor-SDK
mimicry (`openai-node`, `@anthropic-ai/sdk`) awkward. Recommendation stands: TypeScript.
