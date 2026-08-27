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
| 3 | Streaming — SSE parser, relay, timeline, conformance | **Done** | 13/13 (+20 unit) | pending |
| 4 | Vendor SDK adapters (`openai`, `@anthropic-ai/sdk`) | Not started | — | — |
| 5 | Governance lab + key minting via management key | Not started | — | — |
| 6 | Tools & MCP | Not started | — | — |
| 7 | Scenario runner, Compare, report export | Not started | — | — |
| 8 | Docs, ESLint, unit tests, BP checklist | Not started | — | — |

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

---

## 6. Gateway findings ledger

What the tool has established about TokenShield. Measured against **Prod US** on
`bedrock-nova-micro` with a Bedrock-scoped key, on the dates given.

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
| Chat streaming conformance | Of 18 frames in one stream: **17 with `id: ""`**, **17 with `created: 0`**, **2 with `delta: null`**. The text is fine; a strict client is not |
| `stream: false` on a streaming call | Answered as ordinary `application/json`, not an empty stream |
| Empty `messages: []` | 400, but authored by Bedrock — the empty array arrives as `null`. Not caught at the gateway |
| Embeddings with a chat model | 400 *"required key [messages] not found"* — a customer asking for embeddings is told `messages` is missing. No model-capability check |
| Nonexistent model | Clean 404, names the model. Correct |
| `/v1/tokens/count` | Undocumented; accepts a chat-shaped body, answers `{"input_tokens": N}` |
| `messages/count_tokens` | Clean 404 for a non-Claude backend: *"token counting is not available for this model's backend"* |
| Guardrails | **This org has no guardrail configured** — `x-tokenshield-guardrail-ms: 0` means the middleware ran with no rules. Blocks Phase 5 governance testing until a rule exists |
| Prod Mumbai | The same key that works on Prod US returns 401 there, and Mumbai reports `total_requests: 0` — separate auth store |
| Budget headers | Live and readable: org `$35.75 / $100`, group `$2.82 / $5.00` |

---

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
