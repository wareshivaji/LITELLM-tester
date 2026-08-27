# TokenShield Client SDK + Lab Console

Be the customer. Drive [TokenShield](../cloudgov-ai-gateway) the way a paying integrator's app
does, and see everything the gateway sends back — including the headers a browser is not
allowed to read.

Two things in one repo:

1. **`@tokenshield/client`** — a real client SDK for the gateway. Every call it makes produces
   one full-fidelity `Exchange`: request, response, all headers, TTFB and total latency, the
   gateway's own signal headers, and a **named verdict** for what happened.
2. **Lab Console** — a local backend + React UI on top of that SDK, so any gateway behaviour can
   be driven and inspected without writing a script.

This is not a replacement for [`tokenshield-compat-tests`](../tokenshield-compat-tests). That
suite is the raw conformance bench; this is the interactive client. Two tools, two jobs.

---

## Quickstart

```bash
npm install
cp .env.example .env.local     # then add at least one TSLAB_KEY_<ALIAS>=cg-ak-…
npm run dev
```

Then open **http://127.0.0.1:5173**.

`npm run dev` builds the SDK, then runs the backend (`127.0.0.1:8787`) and the Vite dev server
(`127.0.0.1:5173`) together. The UI talks only to the backend; Vite proxies `/api` across.

---

## What works today — Phase 1

The **Connect** page. Pick a profile and a key, hit **Run preflight**, get five checks that call
no provider and cost nothing:

| Check | Endpoint | Answers |
|---|---|---|
| Gateway reachable | `GET /health` | is this base URL a live gateway |
| Connectivity probe | `HEAD /` | does it answer the probe Claude clients send at startup |
| Key accepted | `GET /v1/models` | does this credential authenticate, presented this way |
| Models available | (same call) | what `allowedModels` actually resolves to for this key |
| Gateway metrics | `GET /api/v1/metrics` | RPM, latency and error counters |

Plus the **exchange log** — every call the lab has made this session, expandable into a request
and response inspector with the gateway's signal headers highlighted.

Targets can be added straight from the console — see [Configuration](#configuration) — so pointing
at a different gateway or trying a different key needs no file edit and no restart.

Phases 2–8 (Playground, streaming, vendor-SDK adapters, governance lab, MCP, scenarios) are in
[`docs/PLAN.md`](docs/PLAN.md). The sidebar shows them greyed out with their phase number.

---

## Layout

```
packages/client   @tokenshield/client   transport · recorder · classifier · surfaces
packages/server   @tokenshield/lab-server  Fastify, 127.0.0.1, in-memory ring buffer
packages/web      @tokenshield/lab-web     React + Vite console
scenarios/        declarative suites (Phase 7)
docs/             PLAN.md · GATEWAY_SURFACE.md
out/              exported reports (gitignored)
```

### Why there is a backend at all

Not preference — four hard reasons:

1. **The browser cannot read the headers we came for.** The gateway sets `AllowOrigins: "*"` but
   never sets `ExposeHeaders`, so page JavaScript only ever sees the six CORS-safelisted response
   headers. `X-Request-ID`, every `X-*-Budget-*`, `x-should-retry`, `Retry-After` and
   `x-tokenshield-guardrail-ms` are invisible to it. Those headers are half the signal.
2. **The key must never reach the browser.** The UI works in aliases; raw values live only in the
   backend's memory and are masked (`cg-ak-abcd…wxyz`) in every response, log line and export.
3. **Real-SDK mimicry is a Node concern** (Phase 4) — `openai` and `@anthropic-ai/sdk` are meant
   to run server-side, which is exactly how customers run them.
4. **Burst and loop work belongs off the UI thread** — RPM tests, budget-exhaustion loops,
   scenario suites.

### Storage policy

**No database.** No Mongo, no ClickHouse, no SQLite, no Redis. History is an in-memory ring
buffer (`TSLAB_HISTORY_LIMIT`, default 200); restart the backend and it is gone, by design. The
only disk writes are your `.env.local` and whatever you explicitly Export into `out/`.

---

## Configuration

Two ways in, and the UI shows which is which.

### From the console — no restart, nothing saved

**+ add** next to **Gateway** or **API key** on the Connect page. Type a label and a base URL, or
an alias and a key, and it appears in the dropdown immediately.

These are **session targets**. The key you paste crosses loopback once, is held in the backend's
memory, and is never written to `.env.local`, never returned to the browser, and never put in
`localStorage` — reload the page and it is still listed, because the backend has it and the tab
does not. Restart the backend and session targets are gone. The dropdown groups them under
"This session — gone on restart" so that is never a surprise.

An alias that already exists is **rejected, not shadowed**. Silent credential precedence is the
exact bug that made a whole Python test run authenticate as the wrong key, and a friendlier form
is no reason to reintroduce it.

### From `.env.local` — for the ones you use daily

Gitignored. See [`.env.example`](.env.example) for the annotated template.

```dotenv
TSLAB_PROFILE_LOCAL=Local gateway|http://localhost:4000
TSLAB_PROFILE_PROD_US=Prod US|https://gateway.cloudgov.ai
TSLAB_DEFAULT_PROFILE=local

TSLAB_KEY_MY_KEY=cg-ak-…
TSLAB_DEFAULT_KEY=MY_KEY
```

**Keys are read from that file and from nowhere else** — never from the ambient environment.
That is deliberate. In the Python suite a stale `TS_KEY` left over in a PowerShell session
silently outranked the key the runner thought it was using, and every request authenticated as
the wrong key. Reading the file only, under a `TSLAB_` prefix that collides with nothing in this
workspace, makes that failure mode structurally impossible.

The **target strip** at the top of every page always shows which gateway, which key alias and
which auth header the next call will use. Same reason.

---

## Troubleshooting

**`Port 8787 is already in use`** — `tsx watch` runs the server in a child process, so closing
the terminal can leave that child holding the port. Clear it:

```bash
npx kill-port 8787
```

On Windows, the direct route:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**`ECONNREFUSED — nothing is listening at http://localhost:4000`** — the local gateway is not
running. Start it from the gateway repo:

```bash
go run ./cmd/gateway
```

Same trap applies there: `go run` spawns a child `gateway.exe`, and killing the parent can leave
it bound to :4000. If requests behave inconsistently, clear everything and start exactly one:

```powershell
Get-Process go,gateway -ErrorAction SilentlyContinue | Stop-Process -Force
```

**A local gateway talks to the shared prod Mongo and ClickHouse.** Keys, spend and usage rows
are real. From Phase 5 the console can mint disposable keys — name them `sdk-lab-*`, give them a
tiny budget and a short expiry.

**Preflight passes but a later call fails right after you changed a policy** — the gateway caches
API keys and credentials for 900s by default (`API_KEY_CACHE_TTL_SECONDS`,
`CREDENTIAL_CACHE_TTL_SECONDS`). The change may simply not have landed yet.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | build SDK, then run backend + UI together |
| `npm run build` | build all three packages |
| `npm run typecheck` | `tsc --noEmit` across all three |
| `npm run format` | Prettier |
| `npm run dev:server` / `dev:web` | run one side on its own |

---

## Safety

This console holds live gateway credentials and has **no authentication of its own**. The backend
binds `127.0.0.1` only. Never expose it, never deploy it, never put a real key anywhere but
`.env.local`.
