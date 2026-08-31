# Architecture, decisions and tracking

The single reference for **how this is built, why it is built that way, and where it has got to**.
Updated at the end of every phase. If something here disagrees with the code, the code is right and
this file is a bug.

- Forward-looking plan: [PLAN.md](PLAN.md)
- The gateway contract this is written against: [GATEWAY_SURFACE.md](GATEWAY_SURFACE.md)
- How to run it: [../README.md](../README.md)

---

## 1. What this is, and what it is not

TokenShield (`~/Cloudgov/cloudgov-ai-gateway`) is an OpenAI-compatible AI gateway. It already has
two things pointed at it:

| Existing | What it is |
|---|---|
| `~/Cloudgov/tokenshield-compat-tests` | Python scripts + pytest. The raw conformance bench. Results land in `.txt` / `.xlsx` |
| `cloudgov-ui` TokenShield console | The **admin** side — creates keys, sets budgets and guardrails, reads traces |

Neither is a customer. This repo is: **a real client SDK plus a UI that drives it**, so any gateway
behaviour can be provoked and inspected the way a paying integrator's application would experience
it. It is not a replacement for the Python suite — that stays the regression bench. Two tools, two
jobs.

---

## 2. System shape

```
┌─────────────────────────────────────────────────────────────────────────┐
│ packages/web        React + Vite, 127.0.0.1:5173                        │
│                                                                         │
│   Connect · Playground · Streaming    (+4 pages, phases 4-7)            │
│   sees: masked key aliases, Exchange records                            │
│   never sees: a raw credential, the gateway itself                      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  /api/*  (Vite dev proxy, one origin)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ packages/server     Fastify, 127.0.0.1:8787, no auth of its own         │
│                                                                         │
│   TargetRegistry   .env.local targets + session targets, one lookup      │
│   RunStore         in-memory ring buffer (default 200). No database.     │
│   routes           /api/config /preflight /models /exchange /stream      │
│                    /targets/* /runs                                      │
│   holds: the only copy of every raw cg-ak- / cg-mk- value                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  uses
┌───────────────────────────────▼─────────────────────────────────────────┐
│ packages/client     @tokenshield/client — the SDK                        │
│                                                                         │
│   Transport   the ONE place an HTTP call is made. send() + stream()      │
│   classify    status + body  →  a named verdict                          │
│   signal      response headers → budget / request-id / guardrail timing  │
│   redact      masking, on every path out                                 │
│   sse         pure incremental SSE parser (also used by the browser)     │
│   stream      recorded-stream analysis + conformance checks              │
│   surfaces    the 8 endpoints, described once                            │
│   probes      14 edge cases + what a live gateway actually did           │
│   curl        reproduce an exchange elsewhere, without the key           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  HTTPS
                     ┌──────────▼──────────┐
                     │  TokenShield gateway │
                     └──────────────────────┘
```

### Request flow, buffered

`UI → POST /api/exchange → resolveTarget → TokenShieldClient.call → Transport.send → gateway`
→ headers + body captured → `classify` → `Exchange` → `RunStore` → returned to the UI whole.

### Request flow, streaming

Two streams, not one:

```
gateway ──SSE──► Transport.stream ──┬──► onChunk → relay writes `event: chunk`  ──SSE──► browser
                                    └──► accumulates chunks
                                              ↓ stream ends
                                    Exchange → RunStore → relay writes `event: done`
```

The browser parses the relay with **the same `SSEParser`** the backend used on the gateway. One
parser, one set of edge cases.

---

## 3. The core type: `Exchange`

Everything the SDK does produces exactly one of these. The backend stores them, the UI renders
them, and (Phase 7) the scenario runner asserts on them. One record type is why a Playground call,
a scenario step and a vendor-SDK call are directly comparable.

```
Exchange
├─ id, profileId, profileLabel, baseUrl     which gateway this actually hit
├─ keyAlias, authScheme                     which credential, presented how
├─ surface, mode                            'chat.completions', 'raw' | 'openai-sdk' | …
├─ request   { method, url, path, headers (REDACTED), body }
├─ response  { status, statusText, headers, body, bodyText, chunks[] }
├─ timings   { startedAt, ttfbMs, totalMs, guardrailMs }
├─ gateway   { requestId, organizationId, retryAfterSeconds, shouldRetry,
│              guardrailMs, mcpSessionId, budget{request,key,user,group} }
├─ verdict   { kind, envelope, detail, code, type }
└─ transportError                           set only if no response arrived
```

`verdict.kind` is the point: not "it failed" but `budget` / `ratelimit` / `guardrail` /
`model-denied` / `no-credential` / `auth` / `tool-policy`. `verdict.envelope` is recorded
*separately*, because which error shape came back is a finding in its own right.

---

## 4. Architectural decisions

Each one records what was decided, why, and what was rejected. Numbered so they can be referred to
and superseded rather than quietly reversed.

### AD-01 · TypeScript across all three layers
**Why.** One language for SDK, backend and UI means one set of types (`Exchange`, `LabProfile`,
`StreamChunk`) shared end to end, so the server and the UI cannot drift. The two client SDKs
customers actually use — `openai` and `@anthropic-ai/sdk` — are first-class in Node, which Phase 4
depends on.
**Rejected.** Python + FastAPI. It would reuse the compat-tests' knowledge, but splits the stack
from the React UI and makes vendor-SDK mimicry awkward.

### AD-02 · A backend exists, despite "no database"
**Why.** Four reasons, in order of force:
1. **The browser cannot read the headers we came for.** The gateway sets `AllowOrigins: "*"` but
   never sets `ExposeHeaders`, so page JavaScript only ever sees the six CORS-safelisted response
   headers. `X-Request-ID`, every `X-*-Budget-*`, `x-should-retry`, `Retry-After` and
   `x-tokenshield-guardrail-ms` are **invisible** to it. Those headers are half the signal.
2. The key must never reach the browser.
3. Vendor-SDK mimicry is server-side by nature — that is how customers run those SDKs.
4. Burst and loop work (RPM tests, budget exhaustion, scenario suites) does not belong on the UI
   thread.
**Consequence.** Every call takes one extra hop. Worth it; without it the tool cannot see what it
exists to see.

### AD-03 · No database. In-memory ring buffer, explicit export
**Why.** A stated constraint, and a correct one: this is a black-box client, and anything it
persisted would become a second source of truth about gateway behaviour alongside ClickHouse.
History is `RunStore`, capped at `TSLAB_HISTORY_LIMIT` (default 200); restart and it is gone.
**Consequence.** Rebuilding the SDK restarts the backend (`tsx watch` sees `dist` change) and
therefore clears the log. Documented in the README, because it looks like data loss and is not.

### AD-04 · One `Transport`, one `Exchange`
**Why.** If some calls were made elsewhere they would be recorded differently, or not at all, and
comparability is the whole product. `send()` and `stream()` share a private `prepare()` so a
streaming call and a buffered one cannot diverge in how they authenticate, record or redact.

### AD-05 · Request bodies are `unknown` and go out untouched
**Why.** A typed SDK would refuse to send `stop` as a string or `content` as an array — which are
exactly the calls that expose gateway bugs. A client that quietly fixes a malformed request cannot
be used to find out how the gateway answers one. The body editor in the UI is the source of truth
and is sent verbatim.
**Consequence.** No compile-time help on request shapes. Accepted deliberately.

### AD-06 · Credentials come from `.env.local` and never from the ambient environment
**Why.** In the Python suite a stale `TS_KEY` left in a PowerShell session silently outranked the
key the runner thought it was using, and every request authenticated as the wrong key — two hours
of "works when I run it, 403 when you run it". The config loader parses the file into its own
object; `process.env` is never consulted for a credential. All variables use a `TSLAB_` prefix that
collides with nothing else in the workspace.
**Verified.** Test P1-03: four hostile env vars set, all four ignored.

### AD-07 · An alias is never shadowed
**Why.** Same root cause as AD-06. Adding a session key whose alias already exists is **rejected
with an error**, not silently preferred. Offering silent precedence behind a friendlier form would
be worse than the file edit it replaces. Targets declared in `.env.local` also cannot be deleted
through the API.

### AD-08 · Session targets live in memory, never on disk
**Why.** Editing a file and restarting a server to point at a different gateway was a Phase-1
shortcut. UI-entered targets fix that without turning the console into something that writes
credentials to disk. They are tagged `session` in every dropdown and in the target strip, and are
gone on restart — a property that must be visible, not discovered.
**Rejected.** A "Save to .env.local" button. It would make the console write credentials from a web
form; available later if wanted, but not the default.

### AD-09 · `verdict` and `envelope` are separate fields
**Why.** The gateway answers with three different error shapes — OpenAI's `{error:{…}}`,
Anthropic's `{type:"error",error:{…}}`, and a flat `{"error":"string"}` that no OpenAI SDK can
parse. *Which* one came back is a compatibility finding independent of *why* the call failed, so
conflating them would lose one of the two.

### AD-10 · The SSE parser is pure, and shared with the browser
**Why.** Two places need to parse SSE: the backend on the gateway's stream, and the browser on the
relay. A second implementation is a second set of bugs. `SSEParser` takes bytes plus an arrival
time and returns frames — no fetch, no timers.
**What it must get right** (all covered by `packages/client/test/sse.test.mjs`): a frame is
terminated by a blank line and not by a read boundary; a multi-byte UTF-8 character can straddle
two reads and must be decoded incrementally; a frame whose payload is not JSON is **kept** with
`parsed` absent, because that is the finding.

### AD-11 · Client disconnect is detected on the response stream
**Why.** Found the hard way in Phase 3. Since Node 16 an `IncomingMessage` emits `close` once its
body has been consumed — which Fastify has already done to parse the JSON — so a request-side
listener fires within a millisecond and aborts **every** stream before the first frame. The
`ServerResponse`'s `close` is the socket actually going away.

### AD-12 · Switch on what arrived, not on what was asked for
**Why.** Also found in Phase 3. Not every answer to a streaming request is a stream: a rejection is
JSON, and so is a request the gateway decided not to stream (`stream: false`). Reading either with
an SSE parser finds no `data:` field and throws the entire body away. `Transport.stream` therefore
checks the response `content-type` and falls back to buffered reading.

### AD-13 · The probe registry records measured behaviour, not beliefs
**Why.** Each probe carries what a live gateway actually did, with the date. `landmine: true` means
known-wrong, so a probe that starts passing is a **fix**, not a flake — the same signal the Python
suite gets from an XPASS under `xfail(strict=True)`. Phase 2 flipped LANDMINE-2 to fixed and pinned
LANDMINE-3's cause this way.

### AD-14 · Copy-as-curl emits `$TOKENSHIELD_KEY`
**Why.** The purpose of the button is handing someone a command in a bug report. The masked value
would look runnable and silently 401; the real value must never be pasted into a ticket.

### AD-15 · The body editor wins once it has been hand-edited
**Why.** Changing surface, model or prompt regenerates the body — but only while `dirty` is false.
Silently overwriting a hand-built request is the fastest way to make a tool untrustworthy.

### AD-16 · Backend binds `127.0.0.1` and has no authentication
**Why.** It holds live gateway credentials. It is a local developer tool; the correct security
posture is to be unreachable rather than to grow an auth system.
**Verified.** Test P1-15: both LAN addresses refuse.

### AD-17 · The stream timeout is a whole-stream budget
**Why.** A stream that stalls forever after one token is a failure worth catching, and there is no
safe way from the client side to distinguish "the model is thinking" from "the connection is dead".
A per-read timeout would need a guess at an acceptable inter-token gap.

### AD-20 · A minted key is scrubbed from its own recorded exchange
**Why.** `POST /api/v1/management/api-keys` is the only response in this tool whose body contains a
live credential — the gateway shows the new key once and never again. Recorded naively it would sit
in the exchange log, the inspector and every export of them. So the mint route extracts the key,
registers it in the in-memory registry, and runs the Exchange through `redactMintedKey` **before**
it reaches the store. The browser receives an alias and a mask, never the value. The scrub runs on
the failure path too, where a partial body might still carry something.

### AD-22 · A landmine scenario inverts the meaning of a pass
**Why.** A scenario marked `landmine` describes behaviour believed *wrong today*, so its
expectation matching means the bug is still there — reported `landmine-present`, never as a
success. When it stops matching the behaviour moved and a human should look: `landmine-changed`.
Same signal the Python suite gets from a strict `xfail`, and it is why an all-green suite here
would be suspicious rather than reassuring.
**Consequence, found by the first two-target run.** Running a suite against a gateway where the
key is not valid turns every request into a 401 — and each landmine was then reported
`landmine-changed`, which reads as "possibly fixed here". It was not: nothing had been measured.
A scenario whose observed verdict is `auth` or `server-error`, where it did not expect one, is now
`inconclusive`. Scenarios that *expect* an auth failure are exempt, since for those the 401 is the
answer rather than an obstacle.

### AD-23 · Compare is the scenario runner with two targets, not a separate page
**Why.** "Run the same request against two gateways and diff it" and "run a suite" are the same
operation with a different number of targets. One mechanism means the comparison inherits
expectations, landmine semantics and export for free, and every row carries the target that
produced it — a result without its target is not evidence.

### AD-21 · The rate-limit burst uses a free endpoint, and gives up early
**Why (free).** `GET /v1/models` runs the whole middleware chain — auth, ip allowlist, rate limit —
but calls no provider. That is the only reason bursting eighty requests is safe to offer as a
button.
**Why (early abort).** Found by the first real run: a gateway whose auth store is unreachable
answers 500 after a five-second timeout, so a blind eighty-request burst spent 400 seconds learning
nothing. Three consecutive non-200, non-429 responses now abandon the burst and say so, because a
limiter cannot be measured while the gateway is broken in some other way.
**Also.** Attempts are deliberately not all stored — eighty rows would evict the entire ring buffer
and lose whatever the operator was looking at. The first and the rejected one are kept, the rest
counted.

### AD-19 · Vendor SDKs are driven through a recording `fetch`, not reimplemented
**Why.** The point of Phase 4 is what a *real customer's SDK* does, so the SDKs are the stock
published versions and nothing rewrites the requests they build. A `fetch` handed to their
constructors records through `Transport.sendRaw`, which shares `perform()` with `send()` — so an
SDK call and a hand-built call produce the same Exchange and are directly comparable.
**Consequences.** (a) The SDK is handed a *reconstructed* `Response`, because the body has already
been read to record it and a stream can only be read once; `content-encoding` and `content-length`
are dropped from the copy or the SDK tries to decompress plain text. (b) Each retry is its own
fetch and therefore its own Exchange — which is how retry behaviour became measurable at all.
(c) Each SDK declares its own `Fetch` type over its own `Response` shim, so the cast at the
constructor takes its type from the SDK's own signature: a version bump that changes it becomes a
compile error rather than a silent mismatch.
**Rejected.** Reimplementing the SDKs' wire behaviour. It would test our understanding of them
rather than them.

### AD-18 · Prettier + `tsc --noEmit` now; ESLint in Phase 8
**Why.** ESLint 9's flat-config migration is churn that buys nothing while the codebase is this
young. Type checking already catches the class of bug that matters. Revisit with the rest of the
hardening.

---

## 5. Phase tracking

| Phase | Scope | Status | Tests | Commit |
|---|---|---|---|---|
| 1 | Scaffold, SDK core, Connect page, preflight | **Done** | 18/18 | `3941513` |
| 1.5 | UI-entered gateways and keys (session targets) | **Done** | 8/8 | `7bc86d6` |
| 2 | Playground — 8 surfaces, probes, inspector, curl | **Done** | 17/17 | `d15d573` |
| 3 | Streaming — SSE parser, relay, timeline, conformance | **Done** | 13/13 (+20 unit) | `4210c0c` |
| 4 | Vendor SDK adapters (`openai`, `@anthropic-ai/sdk`) | **Done** | 13/13 | `4e917d3` |
| 5 | Governance lab + key minting via management key | **Done** | 11/11 | `36122d3` + follow-up |
| 6 | Tools & MCP | **Done** | 8/8 | `ad5bddd` |
| 7 | Scenario runner, Compare, report export | **Done** | 8/8 | `2a5a92d` |
| 8 | Docs, ESLint, unit tests, BP checklist | **Done** | 87 unit tests | `3dfe327` |

**All eight phases complete.** Verified end to end from a clean clone: `npm install` → `npm run
build` → `npm run typecheck` (0 errors) → `eslint .` (exit 0) → `npm test` (87 passed).

**Working agreement.** One phase at a time: build, stop, wait for "start next". Test cases are
presented for approval **before** they run. Nothing is pushed without an explicit decision on where.

### Test ledger

- **Phase 1** — reachability, auth, catalogue, masking, transport errors, env-injection resistance,
  ring-buffer cap, loopback-only bind, no-disk-writes, fail-fast on an unreachable target.
- **Phase 1.5** — session gateway usable immediately; session key authenticates; alias collision
  refused with the file entry intact; four classes of bad URL rejected distinctly; session targets
  gone after restart and present after a page reload with both browser storages empty; raw secret
  absent from the add response, `/api/config` and the full exchange record.
- **Phase 2** — baseline chat, Responses, Anthropic messages, embeddings (chat model and a real
  embedding model), both token counters, moderations, parameter probes, bad model, empty messages,
  unauthenticated, malformed-JSON guard, curl safety.
- **Phase 3** — 20 parser assertions; non-streamable surface rejected; 401 on the streaming path;
  chat / Responses / Anthropic streams; `include_usage`; frame conformance; timing; `stream:false`;
  client abort; request-id retention.
- **Phase 7** — three suites (14 scenarios) run individually and free-only; two-target compare
  against Prod US and Mumbai; a deliberate expectation break; mid-run stop; export to `out/` as
  JSON and Markdown. Landmine semantics verified: LM-1 and LM-3 report `landmine-present` on Prod
  US rather than as failures.
- **Phase 6** — MCP browse and aggregate; the swallow test; parallel calls; three `tool_choice`
  modes.
- **Phase 5** — mint refusals; the model-permission probe; the RPM burst; ring-buffer containment;
  minting with a management key; the minted-key redaction check; budget cap with lag measurement;
  IP allowlist; per-key allowedModels.
- **Phase 4** — mode legality per surface; illegal mode rejected; auth failure through both vendor
  SDKs; the flat 501 envelope through the OpenAI SDK, with and without retries; raw vs SDK on chat,
  messages, embeddings and Responses; `stop` as a string and `n=2` through the typed SDK; no retry
  on a 404.

### Defects found in this tool by its own tests

Recorded because they are the reason the tests exist.

| Phase | Defect | Fix |
|---|---|---|
| 1 | Unauthenticated probes logged a key alias they never sent | `credentialSent` gate in `Transport` |
| 1 | "Catalogue skipped" gave the wrong reason when no key was selected | parameterised skip reason |
| 1 | `TypeError: fetch failed` hid the real cause | unwrap `error.cause`, add ECONNREFUSED/ENOTFOUND hints |
| 3 | Every stream aborted itself ~1.5 ms in | AD-11 — listen on the response stream |
| 3 | A non-SSE answer to a streaming request was discarded | AD-12 — switch on `content-type` |
| 3 | An aborted stream lost its `X-Request-ID` | capture headers when they arrive, keep them on the error path |
| 5 | The rate-limit burst had no early abort — 80 × 5 s of timeouts | AD-21 — abandon after 3 consecutive non-200/non-429 |
| 7 | Landmines on an unreachable target reported as `landmine-changed` — reads as "maybe fixed" when nothing was measured | AD-22 — new `inconclusive` outcome |
| 8 | Used a **real API key** as the fixture in `redact.test.mjs` and committed it | Caught by the clean-clone check, which is why that check exists. One commit, one file, zero remotes — it never left the machine. Replaced with an obviously-fake key of the same shape and the commit amended so it never existed in history |
| 6 | Flagged missing `index` on **buffered** tool calls as a conformance failure | False positive: `index` exists only on streaming deltas, never on `tool_calls[]` in a buffered response. Check removed from `tools.ts`; the real one stays in `stream.ts` |

---

## 6. Gateway findings ledger

What the tool has established about TokenShield. Measured against **Prod US** on
`bedrock-nova-micro` with a Bedrock-scoped key, on the dates given.

### Tools and MCP (Phase 6)

Measured on Prod US, `bedrock-nova-micro`, key `CLIENT_SDK_TESTING`, 2026-08-28.

| Finding | Detail |
|---|---|
| **A named `tool_choice` does not restrict** | Offering `get_weather` + `get_time`, prompting only about weather, and forcing `tool_choice: {function:{name:"get_time"}}` produced **both** calls. Naming a tool is supposed to compel that tool and only that tool; here it compels *at least* it. A client relying on the restriction to keep a tool out of reach does not get that guarantee |
| `GET /v1/mcp/servers` cannot distinguish "none configured" from "discovery failed" | Prod answers `{"servers":[]}` / `{"tools":[]}` with a 200. On the local gateway the log showed three servers registered and discovery actually failing (`upstream returned 401 unauthorized: missing_token`) — and the same surface would still report an empty list. A customer sees "you have no MCP servers" either way |
| The client tool round trip works, and the swallow did **not** reproduce | One tool offered → `finish_reason: tool_calls`, a call with a usable `id` and valid JSON arguments, results posted back, final answer incorporating them. The known `resolveCall` swallow needs **≥1 enabled MCP server in the key's scope**, and this key has none — so the precondition is absent, not the bug disproven. Re-test on an org with a working MCP server |
| Parallel tool calls work | Two tools offered, one prompt, two calls in a single turn, each with its own id and parsed arguments |
| `tool_choice: none` and `required` behave correctly | `none` produced prose and no calls; `required` forced a call even for "Say hello" (the model invented an argument, which is expected when compelled) |

### Governance (Phase 5)

| Finding | Detail |
|---|---|
| **`/v1` is not rate limited unless a key or org sets an RPM explicitly** | 100 requests in **297 ms** all returned 200 on a key with no RPM configured. The chain: `DEFAULT_RATE_LIMIT_RPM` (documented as 60 in `.env.example`) is parsed into `cfg.DefaultRateLimitRPM` at `internal/config/config.go:241` and **read nowhere else**; the inference limiter is built as `ratelimit.NewLimiter(0)` (`cmd/gateway/main.go:461`); and `resolveLimit` returns 0 — treated as unlimited — when neither the key nor the org config carries a positive `RateLimitRPM`. The per-org `ratelimit.Middleware` is not mounted anywhere. The limiter works where a limit *is* set (a flat 429 with `retry_after_seconds` has been observed on other keys), so the defect is that the documented **default does not apply** — limiting is opt-in per key or org, which the env var name implies the opposite of |
| The `allowedModels` gate applies on non-generating surfaces | `/v1/tokens/count` returns `403 model_not_allowed_for_key`, so the gate is not surface-specific — and token-count is therefore a free way to ask what a key may use |
| **Budget headers round to 2 decimal places, so a small budget reads as `0.00 / 0.00`** | A key capped at $0.0001 reported `x-key-budget-limit: "0.00"` and `x-key-budget-spend: "0.00"` on every call right up to the rejection. The precision exists — the 429 body carries `spend_usd: 0.000127155` and `limit_usd: 0.0001` — but the headers lose it, so a client cannot watch itself approach a sub-cent cap or self-throttle from them |
| **Budget enforcement is near-real-time, not gated by the spend cache** | The cap tripped on call **#3, 4.9 s** after the first call — not the ~60 s `SPEND_CACHE_TTL_SECONDS` might imply. The enforcer applies an in-flight delta within an instance, so cached spend does not delay it. (Across replicas is a different question this cannot see) |
| The budget rejection body is rich and correct | `type: insufficient_quota`, `code: key_budget_exceeded`, plus `spend_usd`, `limit_usd`, `period` and `budget_name` — everything a client needs to tell the user which cap they hit |
| IP allowlist works and is named | A key minted with `ip_allow_list: ["203.0.113.0/24"]` gives `403` / "Your IP address is not allowed", classified `ip-blocked` |
| Per-key `allowedModels` works | A key restricted to `bedrock-nova-micro` returns 200 for it and `403 model_not_allowed_for_key` naming the refused model for another |
| Budget headers appear only where a budget exists | `CLIENT_SDK_TESTING` returns no `X-*-Budget-*` on **either** prod or local, so their absence is the key having no budget configured — not a local/prod difference. Budget-cap testing therefore needs a key with a cap, i.e. a minted one |
| An infrastructure failure gets two different statuses | Mongo unreachable produced a **500 after 5000 ms** in one window and a **503 after 546 ms** in another, neither with a body explaining that this is transient infrastructure |
| Two keys, two catalogues | `TOOL_CALLING_TEST_0` sees 29 models, `CLIENT_SDK_TESTING` sees 53. Same gateway, same org — the difference is the key's `allowedModels` |

### Operational (local run, 2026-08-28)

| Finding | Detail |
|---|---|
| An unreachable auth store presents as a slow opaque 500 | With MongoDB unreachable, every `/v1/*` call returned **500 after exactly 5000 ms**. Not a 503, no `Retry-After`, nothing telling a client this is transient infrastructure rather than their request |
| The gateway logs "MongoDB connected" immediately after a failed ping | `MongoDB ping failed, will retry on first query` is followed on the next line by `MongoDB connected`. Reading the startup log, it looks healthy |
| The model catalogue silently falls back | `model catalog: failed to load from MongoDB, using fallback` — the gateway then serves a catalogue that may not match the org's |

### Landmine status

| # | Landmine | Status | Evidence |
|---|---|---|---|
| 1 | Flat `{"error":"string"}` envelope no OpenAI SDK can parse | **Present** | `/v1/moderations` → `501` `{"error":"moderation not supported for provider: openai"}` (2026-08-27). Not present on chat/responses/messages error paths, which use proper envelopes |
| 2 | `content` as an array (even text-only) rejected | **Fixed** | 200 where it used to 400 (2026-08-27) |
| 3 | `stop` as a string rejected | **Present, cause pinned** | 400 *"The stop sequence value at inferenceConfig.stopSequences.0 is blank"* — the gateway turns `"\n\n"` into an empty stop sequence rather than a one-element list |

### Other findings

| Area | Finding |
|---|---|
| `/v1/messages` buffered | Rejects its own **mandatory** `max_tokens` on a Bedrock Nova model: *"extraneous key [max_tokens] is not permitted"*. The Anthropic body reaches Bedrock unchanged |
| `/v1/messages` streaming | Answers **HTTP 200**, then a single `event: error` frame carrying that same Bedrock complaint. A client checking `response.ok` sees success and must inspect the stream to learn it failed |
| Chat streaming conformance | Of 18 frames in one stream: **17 with `id: ""`**, **17 with `created: 0`**, **2 with `delta: null`**. The text is fine; a strict client is not. **Streaming-only** — the buffered response on the same surface carries a real `chatcmpl-bedrock-…` id and a real `created` timestamp, so this is the SSE path specifically |
| `stream: false` on a streaming call | Answered as ordinary `application/json`, not an empty stream |
| Empty `messages: []` | 400, but authored by Bedrock — the empty array arrives as `null`. Not caught at the gateway |
| Embeddings with a chat model | 400 *"required key [messages] not found"* — a customer asking for embeddings is told `messages` is missing. No model-capability check |
| Nonexistent model | Clean 404, names the model. Correct |
| `/v1/tokens/count` | Undocumented; accepts a chat-shaped body, answers `{"input_tokens": N}` |
| `messages/count_tokens` | Clean 404 for a non-Claude backend: *"token counting is not available for this model's backend"* |
| Guardrails | **This org has no guardrail configured** — `x-tokenshield-guardrail-ms: 0` means the middleware ran with no rules. Blocks Phase 5 governance testing until a rule exists |
| Prod Mumbai | The same key that works on Prod US returns 401 there, and Mumbai reports `total_requests: 0` — separate auth store |
| Budget headers | Live and readable: org `$35.75 / $100`, group `$2.82 / $5.00` |

### What a real customer's SDK sees (Phase 4)

Stock `openai@4.104.0` and `@anthropic-ai/sdk@0.32.1`, unmodified.

| Finding | Detail |
|---|---|
| **A 401 on `/v1/messages` uses the OpenAI envelope, not the Anthropic one** | `@anthropic-ai/sdk` raises `AuthenticationError` but extracts **no type and no code**, and its message is the raw JSON body. Handler 400s on the same path *do* use the Anthropic envelope, so this is specific to the auth path. A Claude-SDK customer with a bad key gets an unparseable error |
| **`/v1/moderations` 501 is retried three times by default** | 501 is retryable under OpenAI SDK rules and `openai`'s default `maxRetries` is 2, so a permanently-unsupported endpoint costs 3 round trips, 3 gateway log entries and backoff before failing. `x-stainless-retry-count` goes 0→1→2. Returning a non-retryable status (400/404/501→404) would fix it |
| **LANDMINE-3, as the customer experiences it** | A developer writing the perfectly legal `stop="

"` gets `BadRequestError: 400 The stop sequence value at inferenceConfig.stopSequences.0 is blank.` — Bedrock internals, meaningless to them |
| Flat envelope through a typed SDK | The SDK still produces a typed `InternalServerError`, but with no `type` and no `code`, and the message is a quoted JSON string. Better than a crash, useless for programmatic handling |
| The OpenAI SDK parses the gateway's Responses payload | No divergence between raw and SDK on `/v1/responses`. Good news |
| Clients agree on the happy path | chat, embeddings and Responses: identical status, identical output, raw vs SDK |
| A 404 is correctly not retried | `maxRetries=2` on an unknown model still makes exactly 1 attempt |
| `code` is inconsistent across surfaces for the same error | An unroutable model gives `code: model_not_found` on `/v1/chat/completions` but `code: "unknown model: <name>"` on `/v1/tokens/count`. A client keying on `code` breaks depending on which surface it called |
| The `allowedModels` gate applies on non-generating surfaces | `/v1/tokens/count` returns `403 model_not_allowed_for_key` for 6 of 8 cross-provider ids, so the gate is not surface-specific. That also makes it a free way to ask what a key may use |
| Headers real customer traffic carries | Both SDKs add 8 `x-stainless-*` headers (arch, lang, os, package-version, retry-count, runtime, runtime-version, timeout); Anthropic also sends `anthropic-version`. Anything gateway-side that keys off headers sees these in production |

---

## 6b. CloudGov best-practices checklist

Run against Section 8 of `cloudgov-meta-repo/cloudgov-coding-best-practices.md`. Rules scoped to
Java, reactive services, ClickHouse or the Chakra UI are marked N/A with the reason, not silently
ticked.

| Rule | Status | Evidence |
|---|---|---|
| BP-001 no null-pointer scenarios | **Pass** | `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` across all three packages; `?.`/`??` throughout; every external shape read through a defensive reader (`extractModels`, `readOutput`, `readCreatedKey`, `valueAtPath`) that returns a default rather than throwing |
| Appendix A — no `any` in TypeScript | **Pass** | `@typescript-eslint/no-explicit-any: error`; `npx eslint .` exits 0. The only casts are two at the vendor-SDK `Fetch` boundary, typed from each SDK's own constructor signature and commented (AD-19) |
| BP-002 existing functionality not broken | N/A | New standalone repo; nothing depends on it |
| BP-003 no new patterns without confirmation | **Pass** | Stack approved as plan decision D1/D3; 23 numbered decisions recorded with rationale and rejected alternatives |
| BP-004 appropriate logging | **Pass** | One line per event on the backend; credentials masked before any log call. Fastify logs method and URL, never bodies — the mint route's body carries a live key |
| BP-007 no response over 1 MB | **Pass** | `/api/runs` returns summaries and is always bounded (default 50, max 200); full exchanges are fetched one at a time by id; the ring buffer caps total retention at 200 |
| BP-008 no thousands of objects in loops | **Pass** | The rate-limit burst is capped at 150 and abandons after 3 consecutive broken responses; the model probe at 12; suites run sequentially |
| BP-009 unit tests for all new code | **Pass** | 87 tests over the pure modules: SSE parser 20, classifier 22, redaction 21, scenario evaluation 24. The I/O layer is covered by the 60+ live test cases recorded in the ledger |
| BP-103 pagination on list APIs | **Pass** | `/api/runs` takes `limit`, defaults to 50, caps at 200, and returns the applied limit |
| BP-500 no secrets committed | **Pass** | `.env*` gitignored except `.env.example` (placeholders only); every commit scanned for a full-length `cg-ak-`/`cg-mk-` before landing; masking unit-tested; the minted-key redaction verified end to end (P5-07) |
| BP-600 all queries bounded | N/A | No database — AD-03 |
| BP-100/105/107 reactive, `.collectList()`, JVM | N/A | No Java, no reactive runtime |
| BP-101 RBAC, BP-102 `arrayJoin`, BP-104 org filter | N/A | No data layer; the tool is a black-box HTTP client |
| **BP-200 UI follows the CloudGov theme** | **Deviation — declared** | Section 3 scopes this to `cloudgov-ui` and `cloudgov-dashboard`, and this repo is not in the best-practices document's scope list. It uses **Tailwind, not Chakra** — approved as plan decision D3 before any code was written. Rationale: a local, single-operator diagnostic console with no shared components to inherit; pulling in the Chakra design system would add weight and coupling for no user-facing benefit. **If this ever becomes a customer-facing surface, this decision has to be revisited.** |

## 7. Open items

- **Did an aborted stream still bill?** Not answerable from headers — `x-budget-spend` has cent
  resolution and these calls cost ~$0.00001. The tool now retains the aborted stream's
  `X-Request-ID`, so it is answerable with one ClickHouse query on `ai_gateway_usage`. Out of scope
  here by AD-03.
- **Mid-stream guardrail blocking** — untested; needs a guardrail rule on some org. Revisit in
  Phase 5.
- **`GATEWAY_SURFACE.md` branch caveat** — the per-key MCP entitlement and tool-policy sections were
  read from `feature/per-key-mcp-tool-policy`; verification ran against `main`. Re-check before
  relying on them in Phases 5–6.
- **Nothing is pushed.** No remote is configured; siblings live in AWS CodeCommit.
- In dev, React StrictMode double-invokes the model-catalogue effect, so switching target fires two
  free `/v1/models` calls. Disappears in a production build; not worth code to avoid.
