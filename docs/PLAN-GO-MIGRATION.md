# Plan — Go backend, React frontend, and what to build next

**Status: proposed. Nothing here is started.**

Two separate questions, planned together because they interleave: move the logic to Go, and add
capabilities worth having. Some of the additions are cheap **now, in TypeScript**, and should not
wait for the port.

---

## Part 1 — The Go split

### 1.1 What the codebase actually looks like

| Package | Lines | Files | Fate |
|---|---|---|---|
| `client` | 6,213 | 21 | → Go |
| `server` | 2,160 | 6 | → Go |
| `web` (React) | 5,349 | 19 | **unchanged** |
| tests | 2,017 | 10 | → the conformance oracle |

So **8,373 lines move**, 5,349 stay, and 2,017 lines of tests become the thing that proves the Go
port is correct rather than merely compiling.

### 1.2 The structural fact that makes this cheap

Of 21 files in `client`, **only two do any I/O** — `transport.ts` and `preflight.ts`. The other
nineteen are pure functions over data: the SSE parser, the verdict classifier, the field contracts,
the MCP item readers, the wire-name derivation, the scenario evaluator, redaction.

That matters twice over. Pure functions port mechanically and can be verified against the existing
tests by golden files rather than by re-reasoning. And the seam between logic and I/O already exists,
so nothing has to be untangled first.

### 1.3 The honest case for Go — and against

**For, specifically:**

1. **One language with the gateway.** The gateway is Go + Echo. The same engineers maintain both, and
   a Go lab can **import the gateway's own types** — `internal/apierror`, the MCP types — instead of
   transcribing them. That deletes an entire class of bug: this session produced three corrections
   that were all transcription drift (the separator, the per-tool permissions, the 400-vs-403). A
   contract you import cannot drift from itself.
2. **Concurrency is the untested axis.** The walkthrough claims *"the loop runs turns and tools
   strictly in sequence, so nothing here races with the event relay."* Nobody has tested that. In Go,
   50 concurrent brokered streams is about thirty lines and the timing is trustworthy. In Node it is
   awkward and the numbers are noisy.
3. **A single binary is what "scaling" actually means here.** No `node_modules`, runs in CI, runs in
   a container, handed to a colleague as one file. Today this tool exists on one laptop.
4. **Timing fidelity.** Conformance work measures TTFB and inter-frame gaps. Go's HTTP stack gives
   direct control where undici adds a layer.

**Against, and it is real:**

The nineteen pure modules are **already correct and already tested**. Rewriting working, tested code
is risk with no functional gain — *except* for point 1, which is a genuine gain and applies to about
half of them (`classify`, `fields`, `mcp`, `signal`, `surfaces`). For the rest — `sse`, `redact`,
`curl` — Go buys nothing but a rewrite.

**Recommendation:** port, but not uniformly. Port the contract-bearing modules to Go so they can
import the gateway's types. Port transport and orchestration to Go for concurrency and the single
binary. Do **not** rush `sse`/`redact`/`curl` — they are leaf utilities with no drift risk, and they
can be ported last or transliterated verbatim.

### 1.4 The migration strategy: one endpoint at a time

React already talks to the backend over **23 HTTP endpoints**. That is the contract, and it means
the backend can be swapped **endpoint by endpoint** with both running side by side.

```
                    ┌─────────────────┐
   React (5,349) ──▶│  reverse proxy  │──▶ Go   :8788  (migrated endpoints)
   unchanged        │   on :8787      │──▶ Node :8789  (the rest, shrinking)
                    └─────────────────┘
```

Nothing big-bang, nothing unreachable mid-migration, and at every point the tool still works.

**And the lab can test its own migration.** Point the proxy at Go for an endpoint, at Node for the
same one, send the same request to both, and diff. That is exactly what `/api/compare` already does
for SDKs — reused on ourselves.

### 1.5 Phases

| # | Phase | What lands | Risk |
|---|---|---|---|
| **G0** | Scaffold and seam | **DONE** — see below | low |
| **G1** | Contract modules | **DONE, premise corrected** — see below | low |
| **G2** | Transport + streaming | **DONE** — SSE parser + transport, all four fixes tested | **high** |
| **G3** | Orchestration | **NOT DONE** — see below. ~4,900 lines, and the oracle does not reach it | medium |
| **G4** | Retire Node | **HALF DONE** — `lab check` CI mode and single binary shipped; retiring Node waits on G3 | low |

### G0 as built, and one deviation

Go module at `go/`, front door on **:8787**, Node moved to **:8789**. React unchanged.

**Deviation from the plan: `/api/config` was NOT migrated.** It reads the session registry —
gateways and keys typed into the console and held in memory by Node. Serving it from Go would give
two processes two different ideas of the same state, so a gateway added in one would be invisible in
the other. A state split on day one is a bad trade for the appearance of progress.

`/api/health` is **merged** instead: Go calls Node's, adds its own block, returns the union. The
existing shape is preserved exactly, and the seam is proven to handle response transformation —
which is what every later phase needs. `/api/backends` is Go-native and answers even when Node is
down, which is when someone most wants to know what is up.

`X-Lab-Backend: go | node | go+node` on every response, so "which process answered this" is never a
guess.

Verified: proxied bodies are **byte-identical** to Node's; with Node down `/api/health` returns 200
`degraded` rather than failing, and a proxied endpoint returns 502 naming the fix
(`npm run dev:server`). 9 Go tests, and `FlushInterval: -1` is asserted because a buffering proxy
would silently destroy every SSE timing measurement `/api/stream` exists to make.

One narrow config relaxation: `TSLAB_PORT` may now come from the ambient environment so the dev
script can move Node without editing a gitignored file. The rule it bends is about **credentials** —
the stale-`TS_KEY` story that cost two hours — and a port cannot authenticate as anything. Not to be
extended without a reason at least that specific.

### G1 as built — the premise did not survive contact

**Importing the gateway's types is impossible.** Two blockers, found by trying:

1. **Toolchain**, proven: the gateway's `go.mod` says `go 1.25.0`, the toolchain here is `1.22.2`, and
   `go build` refuses before reaching any import. Fixable, and not the real problem.
2. **`internal/`**, not fixable from this side: the gateway module is `cloudgov.ai/ai-gateway` and
   every contract type lives under `internal/` — there is no `pkg/`. Go allows importing an
   `internal` package only from within the subtree rooted at its parent, enforced by the compiler.
   A separate module cannot import them, `replace` directive or not.

So the choice was: get the gateway to expose a `pkg/contract`; move this lab inside the gateway repo;
transcribe again in a new language and gain nothing; or **extract and verify**, which is what landed.

**Extract and verify.** Every value transcribed from gateway source records where it came from, and
`TestGatewaySourceHasNotDrifted` re-reads that source and fails when it no longer says what we
recorded. Three facts so far: the wire-name separator, the 64-character cap, the tool-name sanitiser.

This does not make drift *impossible* the way an import would — it makes it **loud**. That is enough
for the actual problem: all three transcription corrections this session were *"the source changed
and nobody noticed for weeks"*, not *"someone typed it wrong"*. And unlike an import it needs nothing
from another team.

Proven by pointing the check at a copy of `loop.go` with the separator changed to `--`. It failed,
naming the value, the change, and the consequence. It also **skips rather than passes** when the
gateway checkout is absent: a green tick for a check that did not run is a lie.

**The TypeScript is the oracle, and it earned that.** `golden_test.go` reads goldens generated from
the TS implementation and asserts the Go port produces identical answers. The first draft of
`Classify` looked correct and **disagreed in eleven places** — the guardrail check has to run before
every status branch because a guardrail block is a 400, there is a `tool-policy` verdict I had
omitted, an unrecognised 403 falls through to `unknown` rather than `auth`, and a dozen default
detail strings differed. None of that would have been caught by review.

`npm run test:go` regenerates and compares the goldens before running, so Go can never be verified
against a stale oracle. Proven by tampering with a golden: the run stops with `STALE`.

**Verdict on the checkpoint.** The plan said to judge G1 on whether importing deletes the drift
class. Importing turned out to be unavailable, so the honest answer is: **drift is now detected
rather than prevented**, which is most of the value. Whether G2 is worth its risk should be judged on
whether that detection actually fires on the next gateway change.

**G2 is where this can go wrong.** The current streaming code carries four hard-won fixes: listening
on the `ServerResponse` rather than the request, switching on the response content-type rather than
the request's intent, retaining captured headers on the abort path, and rounding after subtracting
for gap timing. Every one of those was a live bug. The Go port must reproduce all four, and the
existing tests are the only reason we would notice if it did not.

### G2 as built

SSE parser matched the oracle on all 20 golden cases first try, plus two
byte-level tests the JSON fixtures cannot express: a multi-byte rune split at
every one of 19 boundaries, and a stream cut mid-rune.

Transport has one test per hard-won fix, each named after the bug it prevents.
Fix 4 earned its keep immediately — my test asserted `Round2(1.005) == 1.01`,
the TypeScript gives `1`, and the **test** was wrong. Comparing the two also
exposed a real divergence on negatives that would never have been noticed by
reading.

### G3 — not done, and why

**~4,900 lines** across preflight, scenarios, prompts, tool loops and
governance. Two reasons it is not a "finish it in the same sitting" job:

**The oracle does not reach it.** G1 and G2 were verifiable because their inputs
are values: a body in, a verdict out; bytes in, frames out. A golden file settles
correctness completely. Orchestration is *sequences of calls with decisions
between them* — the tool loop's turn budget, the scenario runner's early abort
after three consecutive failures, the burst's pacing. None of that is expressible
as a fixture, so it needs live runs against a gateway and real spend to verify,
and a Go port that merely compiles proves nothing.

**The evidence says porting-by-reading does not work here.** The classifier was
about 200 lines of pure logic and my first draft was wrong in eleven places —
caught only because a golden existed. Repeating that over 4,900 lines *without*
a golden is how a rewrite quietly becomes worse than what it replaced.

The way to do it: one endpoint at a time behind the existing proxy, each verified
against Node by sending the same request to both and diffing — the mechanism G0
already built and `/api/compare` already implements for SDKs. That is several
sittings of real work, not a push.

**Nothing is blocked meanwhile.** Every unported endpoint is still served by
Node through the front door, and the tool works exactly as before.

**Suggested checkpoint:** stop after **G1**. If importing the gateway's types genuinely deletes the
drift class — measured by whether the next contract change requires a lab edit — the rest is worth
it. If it does not, G2's risk is not obviously worth paying.

---

## Part 2 — What to build, ranked

Each of these came from something that actually happened this session, not from a feature list.

### 2.1 Differential testing against LiteLLM ⭐ the strongest idea

LiteLLM is now cloned locally and runnable on `:4001`. So: **send the identical request to
TokenShield and to LiteLLM, and diff the responses.**

That changes the question from *"is this right?"* — which needs a human with a spec — to *"what does
the reference implementation do?"*, which is mechanical. Every open question this session becomes a
two-command answer: the 400-vs-403 refusal, the truncation cap, the comma-joined `server_label`, the
missing `input_schema`, the lifecycle event order.

It is the only idea here that produces **new** findings rather than watching known ones.

Needs: LiteLLM running with an equivalent config. Cheap to start — the config is already written in
this repo's notes. **Do this first, and it does not need Go.**

### 2.2 Record / replay cassettes

Capture every exchange to disk, replay it against a new gateway build with **zero spend**.

Their own Appendix C.3 lists *"Re-run the 27 captured Responses cases"* as outstanding, and cost is
the reason it has not happened. A replay harness makes that regression suite free and repeatable,
and turns every live run into a permanent asset instead of a one-off.

Go: natural (`httptest`, JSON on disk). TS: possible but the file handling is nicer in Go.

### 2.3 Shadow the tool

Call an MCP tool **directly** via `/v1/mcp/tools/call`, then call it **through the model**, and diff
what the tool returned against what the model was fed.

This would have caught the 4,032-character truncation on the first run instead of by accident — and
it generalises. The same diff detects mutation, reordering, encoding damage, and any future
truncation change. It converts a lucky find into a standing check.

### 2.4 Findings ledger with fingerprints

Findings currently live in markdown, so nothing tracks them across runs. Give each a stable id and a
reproducer, persist it, and let a run report: **"6 known findings still present, 1 fixed, 1 NEW."**

That is the landmine idea surviving a restart, and it is what makes this usable in CI: the exit code
means something.

### 2.5 Concurrency probe — the untested axis

N concurrent brokered streams. Two specific claims to attack:

- The walkthrough says the loop runs turns and tools strictly in sequence so nothing races with the
  event relay. **Untested.**
- The broker's synthesised items take *"the next value from the same counter the real items use."* A
  shared counter under concurrency is exactly where an off-by-one hides, and a client tracking items
  by index would corrupt its own state.

~30 lines in Go. Effectively the reason to have Go at all.

### 2.6 Surface parity matrix

Make the chat-vs-Responses comparison the headline artifact rather than a per-case footnote: one
matrix, every case, every divergence. It already found the 502-vs-200 split; a matrix would have made
that the first thing anyone saw.

### 2.7 Entitlement drift

Snapshot `/v1/mcp/servers` per key to disk; diff on each run. *"Yesterday this key had 7 usable
tools, today 6 — `hub_repo_details` became blocked."*

Free, no provider call, and directly useful to whoever owns the policies. **Cheap now in TS.**

### 2.8 Envelope fuzzing

Go has native fuzzing, and `fields.ts` already gives the input grammar: generate malformed bodies
from the known field lists and assert that **every** error is a parseable OpenAI envelope. The flat
`{"error":"string"}` shape was found by hand on one endpoint; fuzzing finds the rest.

---

## Part 3 — Execution order

The point of this ordering is that **nothing valuable waits on the port.**

**Now, in TypeScript — no Go needed:**

| # | Item | Why now |
|---|---|---|
| T1 | **2.1 Differential vs LiteLLM** | Highest value of anything here, and LiteLLM is already cloned |
| T2 | 2.7 Entitlement drift | A day's work, free to run, immediately useful |
| T3 | 2.6 Parity matrix | The comparison logic already exists |

**Then the port, with features slotting in where they are cheapest:**

| # | Phase | Feature landing with it |
|---|---|---|
| G0 | Scaffold and seam | — |
| G1 | Contract modules in Go | **2.4** findings ledger (pure logic + a file store) |
| G2 | Transport and streaming | **2.2** cassettes, **2.5** concurrency |
| G3 | Orchestration | — |
| G4 | Retire Node, single binary | **2.8** fuzzing, CI mode |

**Checkpoint after T1.** Differential testing may well produce enough findings to change what is
worth porting at all — there is no sense hardening a lab around questions the reference answers for
free.

**Checkpoint after G1**, as above: judge the port on whether importing the gateway's types actually
deletes the drift class.

---

## What this plan deliberately does not do

**It does not rewrite React.** 5,349 lines, working, and Go changes nothing about it.

**It does not port everything to Go for symmetry.** `sse`, `redact` and `curl` are tested leaf
utilities with no contract drift risk. Porting them buys a rewrite and nothing else, so they go last
or not at all.

**It does not throw away the TypeScript tests.** They are the only reason a Go port can be trusted.
Every phase is verified against them before the TS implementation is retired.
