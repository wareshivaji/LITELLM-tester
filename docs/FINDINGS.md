# TokenShield — what a compliant client hits

One ledger, merged 2026-09-07 from two independently-maintained lists
(convergence Phase 0.4). Written for whoever fixes the gateway: every entry is
something an OpenAI- or LiteLLM-shaped client runs into without doing anything
unusual.

## The 2026-09-09 sweep

**Every `stale` entry has been re-measured, and then the dormant Python suite
was revived and found more. Nine defects were fixed, one no longer reproduces,
and one contradiction that had been recorded as unresolvable is resolved.**

| outcome | n | ids |
|---|---|---|
| **fixed** | 9 | LM-1, LM-2 (text arrays *and* vision), LM-3, LM-6, LM-M1, F-8, F-12, F-15 |
| **still reproduces** | 8 | LM-4, LM-T1, LM-T2, F-4, F-5, F-14, F-16, F-17 |
| no longer reproduces, condition changed | 1 | F-13 |
| could not be measured | 2 | F-6 (needs a big tool payload), F-7 (needs fault injection) |
| untouched, measured 09-06 | 6 | F-1, F-2, F-3, F-9, F-10, F-11 |
| deferred since first recorded | 1 | LM-5 |

**Two of the nine fixes came from the suite, not from the sweep** — LM-2's
vision half and both LANDMINE-1 envelope cases. A person checking by hand sent
text-only content arrays and could not reach an error path that would settle
LM-1; the assertions that answered both were sitting in the repo, unexecuted.
That is the case for keeping the tripwire alive, made by the tripwire.

Cost of the whole sweep: **under four cents**, most of it on the four MCP cases
that need a real tool round-trip. The parameter checks came to $0.000018 —
a refusal is free, so a case only costs anything when the finding has been
FIXED. The bill is a signal, not just a cost.

**The two results worth reading twice.** `LM-M1` had the strongest provenance
here — found independently on both sides — and it is fixed. `LM-2`, called the
broadest compatibility break on the list, is fixed, while `LM-T2` — *the same
root cause on the tool path* — is not. Somebody widened `messages[].content` to
accept an array and did not widen `role:"tool"` content.

**The most consequential thing this sweep found is not in the table.** The
`xfail(strict=True)` markers that this document points to as its enforcement
mechanism have not been executing — see *"The enforcement mechanism this
document claims is not running"* below. LM-2 and LM-3 were fixed and the
tripwire built to notice that was dormant. This sweep is the only reason anyone
knows.

**Two things changed under us that are not findings.** The MCP-enabled key's
servers are now two DeepWiki entries where the ledger recorded HuggingFace, MS
Learn and Cloudflare docs; several MCP entries were re-measured against a
different server set than they were written against, and F-13 is "gone" rather
than "fixed" for exactly that reason. And the same change moved F-4's number:
the injection is now ~1,010 tokens, not ~2,580.

## How to read this

**Check `conf` before acting.** Of the 14 entries carrying `stale` on 09-08,
**8 were wrong by 09-09** — and 2 of the 3 checked on 09-06 had already changed
since 09-02. This gateway moves. Anything not re-verified within a few days is a
lead, not a fact.

| column | meaning |
|---|---|
| **id** | `LM-*` originated in the Python compat suite and cites gateway source. `F-*` originated in this repo. IDs are stable — neither list was renumbered, because both repos reference them. |
| **src** | `py` = `tokenshield-compat-tests`, `ts` = `tokenshield-client-sdk`, `both` = found independently on both sides |
| **conf** | A date = measured then, and still true then. `FIXED <date>` = re-measured and it no longer happens; kept, struck through, because both repos reference these ids and a fixed finding is not a deleted one. `gone <date>` = does not reproduce, but the conditions moved too, so it is not provably fixed. `unmeasurable` / `needs fault injection` = we cannot produce the conditions; the entry stands on its original measurement, not on a current one. |

Reproductions assume Prod US. The parameter cases run on
`bedrock-nova-micro`, the cheapest model in the catalogue, capped at
`max_tokens: 1`; the MCP cases need `bedrock-claude-haiku-4.5` and a key with
MCP servers — `TOOL_CALLING_TEST_0` has six tools, `PROD_TOOL_BLOCKING` has
seven with two blocked, and `CLIENT_SDK_TESTING` has none, which is worth
knowing before an MCP case reports nothing.

Two whole groups are free: the error-envelope cases through
`bin/lab diff -cases testdata/reference-cases.json`, and `/api/governance/burst`
plus `/api/governance/probe-models`, which reach no provider. The Python suite asserts
most `LM-*` entries as `strict=True` xfail, so a fix there turns into a build
failure rather than a silent pass.

---

## P0 — a compliant client is broken, not merely inconvenienced

### F-1 · The moderations error envelope cannot be parsed by any OpenAI SDK
`src: both` · `conf: 09-06` · `POST /v1/moderations` · relates to **LM-1**

Returns `{"error": "some string"}`. Every OpenAI-shaped SDK reads
`error.message`, so the client does not receive a bad error — it throws inside
its own error handler, turning a clean 501 into an unhandled exception. LiteLLM
returns `{"error": {"message": ..., "type": ...}}` for the same call. Three SDK
attempts were made and all three failed.

*Fix:* return the object form. The cheapest high-impact change on this list.

**Tried and failed to re-verify on 2026-09-09, and here is why, so nobody spends
the afternoon twice.** `/v1/moderations` was removed from the tested surfaces
upstream, so the endpoint that produced this is gone from the harness. The flat
envelope is also supposed to appear on a **guardrail block** on chat completions,
which IS in scope — but no key available to us can trip one: three payloads that
should offend a content rule (a destructive shell command, a prompt-injection
attempt, a card number) all returned 200 with
`x-tokenshield-guardrail-ms: 0` on two different orgs. A zero there means the
middleware ran with no rules to apply, so this says "no guardrail is
configured", not "the guardrail passed it".

**So F-1 stands on its 09-06 measurement and cannot currently be re-checked.**
Settling it needs either `/v1/moderations` back in scope or an org with a
guardrail rule actually configured.

### LM-2 · FIXED — ~~`content` as an array is refused, even when it is text-only~~
`src: py` · `conf: FIXED 09-09` · `provider.go:48` · `test_p3_*`, `test_p4_*`

**FIXED, re-measured 2026-09-09.** A text-only content array now returns **200**. This was the
broadest client-compatibility break on the list, so it is the most valuable
fix here. Note LM-T2 is the SAME root cause on the tool path and is still
broken — the fix reached `messages[].content` and not `role:"tool"` content.

**Vision is fixed too, and the hand sweep missed it.** This entry recorded
"vision is unsupported" as part of the same root cause. `test_p4_vision_content`
XPASSED when the suite ran again: a message mixing a `text` part and an
`image_url` part is now accepted. The sweep checked text-only content arrays and
never sent an image, so a person looking by hand got half the answer and the
suite got the other half.

*Originally recorded, and kept verbatim because both repos cite this id:*

OpenAI's `messages[].content` may be a string **or** an array of content parts,
and the array form is what every multimodal-capable client emits — including
text-only clients built on those libraries. The gateway types it as a string, so
the array form 400s and vision is unsupported.

This is the broadest client-compatibility break on the list: it rejects requests
that are valid OpenAI, from clients that never asked for images.

### F-2 · `/v1/responses` silently drops the shorthand user turn
`src: ts` · `conf: 09-06` · `POST /v1/responses`

OpenAI's documented tool-continuation uses `{role, content}` input items. Send
one alongside `function_call` / `function_call_output` items and the user turn
disappears. The model never sees the question.

```
shorthand {role, content}   ->  "I'm ready to help! It looks like I have access to several useful tools"
explicit  {type:"message"}  ->  "The current temperature in Paris is 21C"
```

Same model, same tool output, same minute. Previously returned 400 *"A
conversation must start with a user message"*; now returns **200**. The refusal
was fixed, the drop was not — and a silent wrong answer is worse, because the
400 at least told the client.

*Fix:* normalise the shorthand item to the explicit form before the tool items
are processed. The explicit path already works, which proves only the
normalisation is missing.

### F-3 · A declared `type:"mcp"` block is silently substituted
`src: ts` · `conf: 09-06` · chat completions and responses

Declare an MCP block naming server X; the gateway ignores it, brokers the key's
own configured servers instead, and answers 200 as though nothing happened. A
client that believes it scoped the request to one server has reached two others.

OpenAI documents 400. Even 403 would be defensible. 200-with-substitution is
neither, because nothing tells the client its scoping was discarded.

### LM-T2 · A tool result as a content array fails
`src: py` · `conf: 09-09`

**Still reproduces 2026-09-09** — 400, and now the more interesting half of
the pair: LM-2 was fixed on the same day this stayed broken. Whoever widened
`messages[].content` to accept an array did not widen `role:"tool"` content,
so the agentic round-trip is still refused. One line from the same change.

`role: "tool"` content is string-typed, so a content-**array** tool result is
refused. Same root cause as LM-2, on the tool round-trip path — which is the
path every agentic client uses.

---

## P1 — costs money, or misleads in a way that costs debugging time

### F-4 · MCP tool definitions are injected into every request on an MCP-enabled key
`src: ts` · `conf: 09-09`

**Re-measured 2026-09-09 and the MAGNITUDE moved, because the key's server set
did.** The defect is unchanged; the numbers below are the current ones.

| client sent | billed prompt tokens | 09-06 |
|---|---|---|
| one 7-token user message | **1,018** | 2,593 |
| the same, plus one client-declared `function` tool | **1,355** | 2,700 |

The gap is the key's 6 brokered tool definitions, added to requests that never
asked for tools. A trivial call is billed at roughly **145x** its own size,
where it was ~200x against the older seven-tool set — so the multiplier tracks
whatever happens to be configured, which is itself the point: a client cannot
see it, cannot predict it, and cannot opt out of it.

Key-driven brokering is working as designed; the finding is that a client cannot
opt out per-request and nothing in the response explains the multiplier.

*Fix:* at minimum report injected tokens separately in `usage`. Better: honour a
per-request opt-out.

### F-5 · Brokered tools reach the model with no `input_schema`
`src: ts` · `conf: 09-09`

**Still reproduces 2026-09-09.** `mcp_list_tools` returns six tools each
carrying exactly `description`, `name`, `server_label` — no `input_schema` on
any of them — while `GET /v1/mcp/tools` returns the same tools WITH full
`input_schema` on the same key, minutes apart. The asymmetry is unchanged.

`mcp_list_tools` offers 7 tools carrying exactly `description`, `name`,
`server_label`. No schema on any, so the model is asked to call tools whose
arguments it cannot see.

The gateway is not missing them — `GET /v1/mcp/tools` returns the same tools
*with* schemas the same day (6 properties on `hub_repo_search`, 7 on
`hub_repo_details`). They are dropped on the path where they matter.

### LM-M1 · FIXED — ~~`mcp_list_tools.server_label` names every server at once~~
`src: both` · `conf: FIXED 09-09`

**FIXED, re-measured 2026-09-09.** Each tool now reports its OWN server: three tools labelled
`DeepWiki MCP` and three labelled `https://mcp.deepwiki.com/mcp`, no
comma-joining. A client can tell which server it is about to call. This was
the entry with the strongest provenance in the document — found independently
on both sides — and it is the one that got fixed.

*Originally recorded:*

All 7 tools report `server_label: "HuggingFace,MS Learn,Cloudflare docs"` — a
comma-joined string rather than the server each tool belongs to. A client cannot
tell which server it is about to call. Found independently on both sides, which
is the strongest confidence signal in this document.

### LM-4 · `n > 1` and `logprobs` are dropped rather than refused
`src: py` · `conf: 09-09` · `provider.go:57-72`, `streaming.go:50`

**Still reproduces 2026-09-09.** `n: 2` returns 200 with exactly one choice;
`logprobs: true` with `top_logprobs: 2` returns 200 with no `logprobs` on the
choice. Both silent, as recorded.

`logprobs` is absent from the request struct. `n > 1` returns only `choice[0]`.
`seed`, the penalties and others are silently swallowed. A client asking for 3
completions is billed for what it gets and told nothing about what it did not.

Silent parameter drops are worse than a 400: the client cannot detect them.

### F-6 · Tool output is truncated at ~4,032 characters
`src: ts` · `conf: unmeasurable 09-09` · documented limit is 120,000

**Could not be re-measured 2026-09-09, for the same reason as 09-06.** The cap
needs a brokered tool result longer than 4,032 characters and this key's
servers will not produce one: `read_wiki_structure` completes with a few
hundred characters, and `read_wiki_contents` failed on every attempt. A
`failed` `mcp_call` carries `output: null`, so there is nothing to measure.
**Needs a tool with a large, reliable payload before this can be settled.**

Not only shown truncated to the client — the **model** received the truncated
result and answered from it. 4,032 is suspiciously close to the chat SSE preview
cap of 4,000, so this looks like a chat-path constant leaking onto Responses.
*Not re-verified:* a brokered call on 09-06 returned 2,840 characters and did not
reach the cap.

### F-7 · An auth-store failure looks like a gateway bug and triggers a retry storm
`src: ts` · `conf: needs fault injection`

**Not re-measurable by us at all**, and re-labelled from `stale` to say so.
Reproducing it means taking the auth store down, which is not something this
lab can or should do. It stays on the list because the fix is cheap and
unconditional — 503 with `Retry-After`, and set `x-should-retry` explicitly —
not because we can still see it.

Auth store unavailable → **500 after ~5.15s**, no `Retry-After`, no
`x-should-retry`. The `openai` SDK retries 3x — about 15.5 seconds of hanging —
and monitoring attributes a dependency outage to the gateway.

*Fix:* 503 with `Retry-After`, and set `x-should-retry` explicitly.

### LM-6 · FIXED — ~~An unrouteable model family returns 500, not a clean 4xx~~
`src: py` · `conf: FIXED 09-09` · `test_r2_*`

**FIXED, re-measured 2026-09-09.** `bedrock-deepseek-v3.2` now routes and answers **200** — the
adapter exists, and both deepseek models are in the 53-model catalogue. The
catalogue entry is what prompted the re-check.

*Originally recorded:*

`deepseek-*` has no adapter, so the request 500s instead of returning a 4xx
naming the problem. A 500 tells a client to retry; a 4xx tells it to fix the
request. This one sends clients into retry loops over a permanent condition.

### F-8 · FIXED — ~~The gateway hands its own brokered tool back to the client~~
`src: ts` · `conf: FIXED 09-09`

**FIXED, re-measured 2026-09-09.** A mixed turn — one client-declared `get_weather` against a key
brokering six MCP tools — returned exactly one `tool_calls` entry, for the
client's own tool, with `finish_reason: "tool_calls"`. No brokered tool was
handed back and nothing deadlocked.

*Originally recorded:*

In a mixed turn — a client tool plus the key's MCP tools — the client received a
`tool_calls` entry for `huggingface__hub_repo_search`, a tool it never declared
and cannot execute. Handing the whole turn back is deliberate; handing back a
call the client cannot satisfy leaves it with nothing sensible to do. The mixed
case was prod-confirmed to deadlock. This is also where the `__` wire name
becomes client-visible, which it should not be.

### LM-3 · FIXED — ~~`stop` as a bare string is refused~~
`src: both` · `conf: FIXED 09-09` · `provider.go:67` · `test_p2_*`

**FIXED, re-measured 2026-09-09.** `stop` as a bare string returns **200** on
`bedrock-nova-micro` and `bedrock-claude-haiku-4.5`. Both repos found this and
both called it LANDMINE-3; both can drop it.

**Do not re-raise this from a GLM 400.** `bedrock-glm-4.7` refuses the string
form — and refuses the ARRAY form identically, with
*"This model doesn't support the stopSequences field"*. The control is what
settles it: a provider that supports `stop` in neither shape is a provider
limit, not the gateway's string-versus-array typing bug. Telling the gateway
team to support `stop` on GLM is asking them to fix Amazon. This nearly went
into the ledger as "fixed on some model families only" on the strength of the
string case alone.

*Originally recorded:*

OpenAI accepts `stop` as a string or an array. The gateway types it as
`[]string` only, so the string form produces a blank stop sequence and the
provider refuses. Both repos found this and both call it LANDMINE-3.

### LM-T1 · `parallel_tool_calls` has no request field
`src: py` · `conf: 09-09`

**Still reproduces 2026-09-09.** `parallel_tool_calls: false` is accepted with
a 200 and no error, and nothing in the response acknowledges it.

Silently ignored — there is nowhere for it to be read from. A client disabling
parallel tool calls gets parallel tool calls.

---

## P2 — contract divergences worth fixing, survivable in the meantime

| id | finding | src | conf |
|---|---|---|---|
| F-9 | `messages` is not validated at the gateway; an invalid request round-trips to Bedrock and **Bedrock's error wording reaches the client** (`Value null at 'messages' failed to satisfy constraint`) | ts | 09-06 |
| F-10 | A `/v1/responses` request missing `input` is told to fix **`messages`** — a field that API does not have | ts | 09-06 |
| F-11 | `/v1/models` returns the full 53-model catalogue. Whether it filters by the key is **unverified** — LiteLLM's own error text tells clients to call it "to view available models for your key" | ts | 09-06 |
| F-12 | ~~Chat completions return `id: ""` and `created: 0`~~ — **fixed 09-09**: `id: "chatcmpl-bedrock-1788942498277342916"`, `created: 1788942498` | ts | FIXED 09-09 |
| LM-5 | A mid-stream error frame is not OpenAI-shaped, so an SDK consuming the stream cannot parse the failure | py | deferred — needs fault injection |
| F-13 | ~~A prompt naming an unentitled server returns **502 on chat but 200 on Responses**~~ — **does not reproduce 09-09**: both surfaces answer 200. The key's server set changed since, so this is "gone", not provably fixed | ts | gone 09-09 |
| F-14 | `mcp_list_tools` is emitted only when a tool actually ran, so a client cannot discover tools without spending — **confirmed 09-09**, and it is worse on chat: never emitted there at all, only on Responses alongside an `mcp_call` | ts | 09-09 |
| F-15 | ~~A named `tool_choice` does not restrict the model to that tool~~ — **fixed 09-09**: the named tool was called | ts | FIXED 09-09 |
| F-16 | `/v1` is not rate limited unless an RPM is explicitly set — **confirmed 09-09**: 40 consecutive `GET /v1/models` all 200, no 429. Weaker than the original probe (40 requests over 41s ≈ 58 RPM, against 100 in 297ms first time) | ts | 09-09 (weak probe) |
| F-17 | Budget headers round to 2 decimal places, so small spends read as zero — **confirmed 09-09** on a freshly minted `$0.02/day` key: after a real 200 call, `x-key-budget-spend: 0.00` against `x-key-budget-limit: 0.02`. Also new: the budget headers are **absent entirely** on a key with no budget, so a client cannot tell "no budget" from "not supported" | ts | 09-09 |

---

## Reconciliation — one contradiction the merge exposed

**LM-1 and F-1 disagree about how wide the flat envelope is, and both may be
right at different times.**

- **LM-1** (`py`, cites `handler.go`) asserts the **400** body is flat
  `{"error": str}`, proven by `test_e1_*` / `test_e2_*` on auth failures.
- **F-1** (`ts`, measured 09-06) found `/v1/moderations` flat — but on the same
  day, `lab diff` found 400 and 404 bodies **properly OpenAI-shaped**:
  `error.code: "model_not_found"`, `error.type: "not_found_error"`,
  `error.param: "model"`.

So as of 2026-09-06 the envelope is **inconsistent across paths**, not uniformly
flat. Either the gateway was partially fixed since the Python measurement, or
the two lists are describing different handlers.

That is more actionable than either finding alone — a client cannot write one
error parser — but the scope of LM-1 needs re-measuring before anyone acts on
it. **Not resolved here on purpose:** guessing which is current would put a
false fact in a document whose value is that it does not contain any.

## RESOLVED 2026-09-09 — F-1 was right, LM-1 is fixed

The hand sweep could not settle this. **Reviving the Python suite did**, within
minutes of it running again, and by the mechanism this document had been
claiming all along: two `LANDMINE-1` strict xfails XPASSED.

- `test_e1_unknown_model_error_shape` asserts the error is an **object** with a
  populated `type`. It passes.
- `test_e2_bad_body_error_shape` asserts a 400 body is an object whose `error`
  has at least `message` and `type`. It passes.

**So LM-1's claim — that the 400 body is uniformly flat — is no longer true.**
F-1's half of the disagreement was the accurate one: the envelope is
**per-path**, and the properly-shaped paths are now the rule rather than the
exception. What remains flat is `/v1/moderations`, which is F-1's own subject
and which left the tested surfaces, so no automated check can reach it.

The clearest positive example, from the GLM `stop` refusal:
`{"error": {"message": "This model doesn't support the stopSequences field.
Remove stopSequences and try again.", "type": "invalid_request_error", "param":
null, "code": "bad_request"}}` — correct shape, correct OpenAI `type`, and a
message a client can act on.

*A note on how this was found, because it is the argument for the tripwire.* I
had recorded this contradiction as unresolvable twice: once at the merge, and
again on 09-09 after failing to reach either endpoint by hand. Both times the
answer was already sitting in an assertion that was not being executed.

---

## Where TokenShield is ahead of LiteLLM

Included because a list that only finds fault is not being read carefully, and
because these must not be "fixed" toward the reference.

- **Error fields are correct OpenAI values** — `type: "not_found_error"`,
  `param: "model"`, `code: "model_not_found"`. LiteLLM emits `code: "400"` (the
  HTTP status as a string) and the literal string `"None"` for `type` and
  `param`, which is Python's `None` stringified into JSON.
- **Unknown model returns 404**, OpenAI's status. LiteLLM returns 400.
- **No stack traces in error messages.** LiteLLM puts a Python traceback into
  `error.message` when `messages` is the wrong type.
- **MCP tool policy is exposed correctly.** `GET /v1/mcp/tools` returns every
  tool with a per-tool `policy`, and the `block` entries match exactly what
  brokering withholds. Discovery and enforcement agree.

---

## Not a gateway defect, but it will waste your afternoon

The AWS load balancer in front of Prod returns an HTML `403 Forbidden`
(`Server: awselb/2.0`, no `x-request-id`) for any request whose **body** contains
a loopback URL such as `http://127.0.0.1:8789/...` — an SSRF rule. The gateway
never sees the request.

This sat in our own notes for four days as a gateway finding: *"403, 267ms, fast
enough to be pre-provider"*. It was the edge answering. Any test that puts a
local MCP server URL in a request body is measuring the load balancer.

---

## The enforcement mechanism this document claims is not running

**Measured 2026-09-09.** The note above says the Python suite asserts most
`LM-*` entries as `xfail(strict=True)`, so a fix becomes a build failure rather
than a silent pass. The markers are real — `test_chat_completions.py` carries
seven of them, naming LANDMINE-1 through -4 with their `provider.go` lines.

**They have not been executing.** The gateway-hitting suites need a credential
in the environment and get one from nowhere: `test_chat_completions.py` and
`test_keys.py` reach it through `_util.require_key()`, which reads
`TOKENSHIELD_API_KEY`; `test_tool_calling.py` reads the same variable directly;
only `test_tool_breaking.py` uses the `_creds` alias-slot model that Phase 0.1
introduced. Meanwhile the credentials now live in the lab's `.env.local` as
`TSLAB_KEY_<ALIAS>` slots, which none of those four files know about. So the
suite either skips every gateway test or, collected together, refuses to start —
correctly, and loudly, from `_creds`.

**What that cost:** LM-2 and LM-3 were fixed and nobody found out. The mechanism
built to catch exactly that was dormant, and the fixes surfaced only because
this sweep went and looked. A strict xfail that never runs is not a tripwire,
it is a comment.

**Fixed 2026-09-09.** `_creds` now reads the lab's `.env.local` — importing
the engine's dotenv loader rather than adding a second one — and resolves a key
through `TS_KEY` / `TOKENSHIELD_API_KEY`, then `TSLAB_SUITE_ALIAS`, then the
`TSLAB_DEFAULT_KEY` alias already declared in that file. Every run now prints
the gateway and which variable supplied the key, masked, on line one; the
shadowing bug that cost two hours and the dormancy that cost weeks would both
have been visible there.

**What it found in its first run: six XPASSes.** Four are recorded above (LM-2
text arrays, LM-2 vision, and both LANDMINE-1 envelope cases). The markers for
those are now plain tests, so a regression fails rather than surprising anyone,
and `LANDMINE-3`'s marker was re-pointed — it still xfails, but for a provider
limit rather than the gateway defect its label named, which is a false green.

**One stale assumption remains, and it is a coverage gap rather than a defect.**
The suite is still tuned for a "GLM Testing" key that is no longer in the
credential store: the default model matrix is the three `bedrock-glm-*` models,
so `n > 1`, `logprobs` and the deepseek routing case all SKIP for want of
`TS_MODEL_OPENAI` / `TS_MODEL_DEEPSEEK`. The key now in use reaches 53 models
including nova and claude. Those three cases were covered by hand on 09-09 —
LM-4 and LM-6 above — but the suite cannot see them, so nothing would catch a
regression. Pointing the matrix at the key's real catalogue is the next thing
worth doing here.

---

## Coverage gaps — surfaces nobody tests

Neither repo covers these, so absence of findings here means absence of testing:
`/v1/messages` (what Claude Code uses — manual plan only, in
`claude-cli-gateway-testplan.md`), `/v1/completions`, `/v1/batches`, and token
counting. `/v1/moderations` and `/v1/models` are covered only by this repo;
`/v1/embeddings`, `/v1/files` and smart routing only by the Python suite.
