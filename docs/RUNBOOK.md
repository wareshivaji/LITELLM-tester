# Runbook

Operational detail: how to make each gate fire, and the traps that have wasted time before.

For what the pages are and how to walk through them, see [USER_GUIDE.md](USER_GUIDE.md).

---

## Starting and stopping

```bash
npm run dev     # SDK build, then backend (8787) + UI (5173)
```

**Stop it with Ctrl+C in that terminal.** `concurrently`, `tsx watch` and `vite` are supervisors —
their whole job is to restart the child when it dies — so killing the process that holds a port
just makes the supervisor start another one, and the port is back within a second. Ctrl+C signals
the supervisor and the tree goes with it.

`npx kill-port 8787 5173` is only for the case where the supervisor is *already* gone and an
orphaned child is left holding the port. If you need to stop a running supervisor without its
terminal, target it by name:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*tokenshield-client-sdk*' -and
                 ($_.CommandLine -like '*tsx*' -or $_.CommandLine -like '*vite*' -or $_.CommandLine -like '*concurrently*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Running a local gateway alongside:

```bash
cd ~/Cloudgov/cloudgov-ai-gateway
MCP_TEST_ALLOW_HOSTS='*' MCP_TEST_ALLOW_LOOPBACK=true go run ./cmd/gateway
```

```powershell
Get-Process go,gateway -ErrorAction SilentlyContinue | Stop-Process -Force
```

`go run` spawns a child `gateway.exe`; killing the parent can leave it bound to :4000, and then
requests land on a build you did not mean to test.

---

## Making each gate fire

| Gate | How | Cost | Needs |
|---|---|---|---|
| **Auth** | Select the dud key, or no key | free | — |
| **allowedModels** | Governance → *allowedModels* → Trip it. Probes cross-provider ids via the token counter | free | — |
| **Rate limit** | Governance → *Rate limit* → Trip it (80 × `GET /v1/models`) | free | **An explicit RPM on the key or org** — the documented default does not apply |
| **Key budget** | Mint a key with `budget_limit_usd: 0.0001`, then send ~3 chat calls with `max_tokens: 900` | pennies | a `cg-mk-` key |
| **IP allowlist** | Mint with `ip_allow_list: ["203.0.113.0/24"]`, then use it | free | a `cg-mk-` key |
| **Provider credential** | Ask for a model whose provider the key has no credential for | free | a key missing a provider |
| **Guardrail** | Send a prompt matching a configured rule | free | **a guardrail rule on the org** — not present on the orgs tested |

---

## Telling similar failures apart

The console does this for you in the `verdict` column. The underlying distinctions:

**Two different 429s.**

- `type: insufficient_quota` (or `budget_name` present) → a spend cap.
- Flat `{"error":"rate limit exceeded","retry_after_seconds":N}` → the per-minute limiter.

**Two different 403s.**

- `no_credential_for_provider` → the key has no credential for that provider.
- `model_not_allowed_for_key` → the allowlist refused it, before any provider call.

**A guardrail block is a 400, not a 403**, and carries a flat envelope with
`error: "guardrail_violation"`. Without that marker it is indistinguishable from a malformed
request.

**404 vs 403 on a model.** `404 unknown model` means the gateway does not route it at all.
`403 model_not_allowed_for_key` means it does, and this key may not use it. Only the second
exercises the gate.

---

## Traps

**Which gateway did that actually hit?** The target strip names it on every page and every exchange
record. A result without its target is not evidence.

**Credentials come from `.env.local` and nowhere else.** Never from the ambient environment, under
a `TSLAB_` prefix that collides with nothing. A stale shell variable cannot hijack a run — verified
by test, not assumed.

**An alias is never shadowed.** Adding a session key whose alias exists is refused. Silent
credential precedence is the failure this design exists to prevent.

**Budget headers round to two decimals.** A key capped below a cent reports `0.00 / 0.00` right up
to the rejection. The 429 body carries the real numbers; the headers do not.

**Gateway caches are 900 s by default** (`API_KEY_CACHE_TTL_SECONDS`,
`CREDENTIAL_CACHE_TTL_SECONDS`). A policy change may not have landed yet.

**A local gateway talks to the shared prod Mongo and ClickHouse.** Minted keys, spend and usage rows
are real. Mint `sdk-lab-*` keys with a tiny budget and a short expiry.

**MCP is default-deny locally.** An empty `MCP_TEST_ALLOW_HOSTS` rejects every host and presents as
"MCP is broken" rather than "no hosts allowed".

**The exchange log empties when you edit the SDK.** Rebuilding rewrites `dist`, `tsx watch` restarts
the backend on it, and the history lives in that process.

**Streaming blocks differ per surface.** `/v1/messages` writes bytes before observing them, chat
checks before writing, Responses observes then writes then checks. Do not generalise a streaming
result from one surface to another.

---

## Symptoms

| Symptom | Cause |
|---|---|
| `ECONNREFUSED — nothing is listening at http://localhost:4000` | The local gateway is not running |
| Every `/v1/*` call is a 500 after exactly 5000 ms | The gateway is up but cannot reach its auth store |
| A 503 in ~500 ms | Same root cause, different path. Both are infrastructure, neither says so |
| `Port 8787 is already in use` | A `tsx watch` supervisor is still alive and has restarted its child. Killing the port holder will not help — stop the supervisor |
| Suite rows all say `blocked` | The key is not valid on that gateway |
| The model picker is empty | No key selected, or the key was refused |

---

## Cleaning up minted keys

Keys minted from the Governance page are real. They are named `sdk-lab-*` and given a short expiry,
but delete them from **TokenShield → API Keys** if you would rather not wait.
