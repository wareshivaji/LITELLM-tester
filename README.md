# TokenShield Lab

A customer-side test bench for the CloudGov AI gateway. It sends the requests a
customer's code would send — including the malformed ones — and records exactly
what came back, so questions about the gateway's behaviour become lookups
instead of arguments.

It holds no database. Every exchange lives in an in-memory ring for the life of
the process. That is deliberate: the lab is an instrument, and an instrument
that accumulates state starts having opinions.

**What it has found is in [`docs/FINDINGS.md`](docs/FINDINGS.md)** — 25 entries
(17 `F-`, 8 `LM-`), each with a confidence column, because a four-day-old measurement of a moving
gateway is a hypothesis and not a fact. Three are P0 and actionable by the
gateway team today, independent of anything here.

---

## Run it

Two processes, in two repos that sit side by side.

```bash
git clone <this repo>            # tokenshield-client-sdk
git clone <the engine repo>      # tokenshield-compat-tests
```

**1. Credentials.** Copy `.env.local.example` to `.env.local` and fill in at
least one gateway and one key. Nothing is guessed: a missing credential fails
loudly rather than running unauthenticated, because a lab that silently drops
your key and then reports 401 blames the target for its own bug.

```
TSLAB_PROFILE_LOCAL=Local gateway|http://localhost:4000
TSLAB_KEY_MY_KEY=cg-ak-...
TSLAB_PORT=8801
```

**2. Build the probe and the SDK** (once, and after any change to
`packages/client` or `packages/probe`):

```bash
npm install && npm run build:probe
```

**3. Start the engine**, in the other repo:

```bash
python -m uvicorn engine.app:app --host 127.0.0.1 --port 8801
```

**4. Start the UI**, here:

```bash
npm run dev:web
```

Open <http://127.0.0.1:5173>. The Vite dev server proxies `/api` to the engine,
so the browser has one origin and no CORS of its own to think about.

### Stopping it

Ctrl+C in each terminal. There is no watcher child process to outlive its
parent any more — that used to be the single most common way to get stuck here,
and the section explaining it is gone because the thing it explained is gone.

If a port is still held: `npx kill-port 5173`, or on Windows

```bash
powershell -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
```

---

## How it is put together

Three parts, in two repos, split along one line: **anything that decides what a
response means lives in Python, exactly once.**

| Part | Repo | What it is |
|---|---|---|
| **engine** | `tokenshield-compat-tests` | FastAPI on `127.0.0.1:8801`. Holds the credentials, makes the calls, classifies the verdicts, redacts, serves all 31 endpoints, including the lab's own mock MCP server. |
| **web** | `tokenshield-client-sdk` | React + Vite on `:5173`. Eight pages. Renders exchanges; computes nothing the engine could compute. |
| **probe** | `tokenshield-client-sdk` | One 182-line Node CLI. Reads a job on stdin, drives the *real* `openai` npm package, writes one JSON record to stdout. Spawned per call by the engine. |

```
browser  ──►  vite :5173  ──►  engine :8801  ──►  gateway
                                    │
                                    └─ spawn ──►  probe (node)  ──►  openai npm  ──►  gateway
```

**Why the probe is Node and stays Node.** `openai` and `@anthropic-ai/sdk` are
npm packages. The question that surface answers is *what a customer's SDK does*
— what their `catch` block receives, which headers their SDK adds, how it
retries. A Python reimplementation would answer what our reimplementation does.
Customers use both SDKs, so this is coverage, not duplication.

**Why the probe does nothing else.** It performs HTTP and masks credential
headers before the record exists. The verdict, the gateway signal and the deep
redaction happen in Python. Two implementations of "what does this response
mean", kept honest by comparing their output, is the mistake that cost 1,826
lines in an aborted Go migration — see `docs/CONVERGENCE.md`, D-7 and AD-32.

The job reaches the probe on **stdin, never argv**: a credential in argv is
visible to every process on the machine.

### Packages here

| Path | Package | Contents |
|---|---|---|
| `packages/client` | `@tokenshield/client` | 16 modules: surfaces, fields, probes, tools, MCP, stream analysis, SSE, redaction, curl, the vendor-SDK adapter |
| `packages/probe` | `@tokenshield/lab-probe` | the CLI above |
| `packages/web` | `@tokenshield/lab-web` | the UI |

---

## The gates

Nothing here is trusted because it looks right.

```bash
npm run parity      # all four checks; needs the engine running for the last one
npm test            # 9 TypeScript suites, 318 assertions
npm run typecheck && npm run lint
```

and in the engine repo:

```bash
python -m pytest engine/ litellm_reference_test.py -q    # 170 tests
```

| Gate | What it holds down |
|---|---|
| `sse-parity` | the SSE parser against a recorded byte fixture — deterministic, so byte-exact |
| `scenario-body-parity` | all 16 scenario bodies, generated rather than transcribed |
| `litellm-fields-parity` | `fields.ts` against LiteLLM's own declaration, in-process. A hand-written table rots silently; this makes it rot loudly. It has already caught 7 missing fields and one invented one. |
| `compare-parity` | `/api/compare` against a recorded reference, structurally — it drives a real SDK, so ids and timings differ every run |

**Free by construction.** `compare-parity` runs entirely on an
`INVALID_ON_PURPOSE` alias, so the gateway answers 401 and no tokens are spent.
That is not a cost compromise: a 401 through a real SDK is the most informative
case that surface has, because the gateway's flat `{"error":"string"}` envelope
is not something an OpenAI SDK can parse, and only the SDK shows what the
developer actually receives.

**One gate no longer exists, and it should be said plainly.** `bin/lab diff`
compared the Node backend against the Python engine, endpoint by endpoint, and
was the safety net for the whole migration. Retiring Node retired it.
`testdata/migration-cases.json` (80 cases) is now a historical artefact: it was
green immediately before the deletion, and that was the last run there will ever
be.

---

## Where the documentation is

| File | What it is for |
|---|---|
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | **the output.** One ledger, 25 entries, with a confidence column |
| [`docs/CONVERGENCE.md`](docs/CONVERGENCE.md) | the plan that produced the current shape: 9 phases, decisions D-1..D-9, and a change log kept as the work happened |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | the design in detail, with diagrams |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | what each page is for |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | operating it |
| [`docs/GATEWAY_SURFACE.md`](docs/GATEWAY_SURFACE.md) | what the gateway exposes |
| [`docs/LITELLM_CONTRACT.md`](docs/LITELLM_CONTRACT.md) · [`docs/REFERENCE_COMPARISON.md`](docs/REFERENCE_COMPARISON.md) | LiteLLM as the reference implementation |
| `docs/PLAN*.md` | superseded. `PLAN-GO-MIGRATION.md` documents an approach that was **abandoned**, kept because the reason is worth more than the code was |
| `engine/README.md` (other repo) | the engine's own endpoint inventory and gate history |

---

## Two things that will save you an afternoon

**A loopback MCP URL against a remote gateway measures the load balancer.** The
lab's mock MCP server is on `127.0.0.1`, and AWS's ALB rejects a loopback
address in a request body before the gateway ever sees it — a 403 in ~267ms with
`Server: awselb/2.0` and no `x-request-id`. Every `declared`-mode case run
against Prod is therefore testing Amazon. Against the `local` profile, where
nothing sits in between, the same case is real coverage. This was recorded as a
gateway defect for four days before anyone read the response headers.

**`request_type` in LiteLLM cannot answer a question about the Responses API.**
It accepts `chat_completion`, `embeddings`, `transcription`. `"responses"` is
not among them and LiteLLM does not reject it — it silently returns the
chat_completion answer, as does any nonsense value. There is a test pinning
that so nobody spends the same afternoon twice.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:web` | the UI (the engine runs separately, in the other repo) |
| `npm run build:probe` | build the SDK, then the probe — do this before starting the engine |
| `npm run build` | build all three packages |
| `npm run parity` | the four gates above |
| `npm test` · `npm run typecheck` · `npm run lint` | the rest |
| `npm run check:drift` | `bin/lab check` — re-reads the gateway's own source for the facts the expectations depend on |
| `npm run diff:reference` | `bin/lab diff` against LiteLLM on `:4001`, for the error-envelope comparison |
