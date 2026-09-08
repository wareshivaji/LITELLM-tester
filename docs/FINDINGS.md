# TokenShield — what a compliant client hits

One ledger, merged 2026-09-07 from two independently-maintained lists
(convergence Phase 0.4). Written for whoever fixes the gateway: every entry is
something an OpenAI- or LiteLLM-shaped client runs into without doing anything
unusual.

## How to read this

**Check `conf` before acting.** Two of the three findings re-checked on
2026-09-06 had already changed since 2026-09-02, so anything not re-verified
recently is a lead, not a fact.

| column | meaning |
|---|---|
| **id** | `LM-*` originated in the Python compat suite and cites gateway source. `F-*` originated in this repo. IDs are stable — neither list was renumbered, because both repos reference them. |
| **src** | `py` = `tokenshield-compat-tests`, `ts` = `tokenshield-client-sdk`, `both` = found independently on both sides |
| **conf** | `09-07` / `09-06` = measured then. `stale` = measured 2026-09-02 or earlier and not re-checked. `deferred` = needs fault injection we do not have. |

Reproductions assume `bedrock-claude-haiku-4.5` on Prod US with an MCP-enabled
key. `bin/lab diff -cases testdata/reference-cases.json` reproduces the
error-envelope group in one command and spends nothing. The Python suite asserts
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

### LM-2 · `content` as an array is refused, even when it is text-only
`src: py` · `conf: stale` · `provider.go:48` · `test_p3_*`, `test_p4_*`

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
`src: py` · `conf: stale`

`role: "tool"` content is string-typed, so a content-**array** tool result is
refused. Same root cause as LM-2, on the tool round-trip path — which is the
path every agentic client uses.

---

## P1 — costs money, or misleads in a way that costs debugging time

### F-4 · MCP tool definitions are injected into every request on an MCP-enabled key
`src: ts` · `conf: 09-06`

| client sent | billed prompt tokens |
|---|---|
| one short user message (12 tokens through LiteLLM) | **2,593** |
| ~300-byte body declaring one unrelated `function` tool | **2,700** |

The gap is the key's 7 allowed tool definitions — 6,936 characters, ~1,734
tokens — added to requests that never asked for tools. A trivial call is billed
at roughly 200x its own size.

Key-driven brokering is working as designed; the finding is that a client cannot
opt out per-request and nothing in the response explains the multiplier.

*Fix:* at minimum report injected tokens separately in `usage`. Better: honour a
per-request opt-out.

### F-5 · Brokered tools reach the model with no `input_schema`
`src: ts` · `conf: 09-06`

`mcp_list_tools` offers 7 tools carrying exactly `description`, `name`,
`server_label`. No schema on any, so the model is asked to call tools whose
arguments it cannot see.

The gateway is not missing them — `GET /v1/mcp/tools` returns the same tools
*with* schemas the same day (6 properties on `hub_repo_search`, 7 on
`hub_repo_details`). They are dropped on the path where they matter.

### LM-M1 · `mcp_list_tools.server_label` names every server at once
`src: both` · `conf: 09-06`

All 7 tools report `server_label: "HuggingFace,MS Learn,Cloudflare docs"` — a
comma-joined string rather than the server each tool belongs to. A client cannot
tell which server it is about to call. Found independently on both sides, which
is the strongest confidence signal in this document.

### LM-4 · `n > 1` and `logprobs` are dropped rather than refused
`src: py` · `conf: stale` · `provider.go:57-72`, `streaming.go:50`

`logprobs` is absent from the request struct. `n > 1` returns only `choice[0]`.
`seed`, the penalties and others are silently swallowed. A client asking for 3
completions is billed for what it gets and told nothing about what it did not.

Silent parameter drops are worse than a 400: the client cannot detect them.

### F-6 · Tool output is truncated at ~4,032 characters
`src: ts` · `conf: stale` · documented limit is 120,000

Not only shown truncated to the client — the **model** received the truncated
result and answered from it. 4,032 is suspiciously close to the chat SSE preview
cap of 4,000, so this looks like a chat-path constant leaking onto Responses.
*Not re-verified:* a brokered call on 09-06 returned 2,840 characters and did not
reach the cap.

### F-7 · An auth-store failure looks like a gateway bug and triggers a retry storm
`src: ts` · `conf: stale`

Auth store unavailable → **500 after ~5.15s**, no `Retry-After`, no
`x-should-retry`. The `openai` SDK retries 3x — about 15.5 seconds of hanging —
and monitoring attributes a dependency outage to the gateway.

*Fix:* 503 with `Retry-After`, and set `x-should-retry` explicitly.

### LM-6 · An unrouteable model family returns 500, not a clean 4xx
`src: py` · `conf: stale` · `test_r2_*`

`deepseek-*` has no adapter, so the request 500s instead of returning a 4xx
naming the problem. A 500 tells a client to retry; a 4xx tells it to fix the
request. This one sends clients into retry loops over a permanent condition.

### F-8 · The gateway hands its own brokered tool back to the client
`src: ts` · `conf: stale`

In a mixed turn — a client tool plus the key's MCP tools — the client received a
`tool_calls` entry for `huggingface__hub_repo_search`, a tool it never declared
and cannot execute. Handing the whole turn back is deliberate; handing back a
call the client cannot satisfy leaves it with nothing sensible to do. The mixed
case was prod-confirmed to deadlock. This is also where the `__` wire name
becomes client-visible, which it should not be.

### LM-3 · `stop` as a bare string is refused
`src: both` · `conf: stale` · `provider.go:67` · `test_p2_*`

OpenAI accepts `stop` as a string or an array. The gateway types it as
`[]string` only, so the string form produces a blank stop sequence and the
provider refuses. Both repos found this and both call it LANDMINE-3.

### LM-T1 · `parallel_tool_calls` has no request field
`src: py` · `conf: stale`

Silently ignored — there is nowhere for it to be read from. A client disabling
parallel tool calls gets parallel tool calls.

---

## P2 — contract divergences worth fixing, survivable in the meantime

| id | finding | src | conf |
|---|---|---|---|
| F-9 | `messages` is not validated at the gateway; an invalid request round-trips to Bedrock and **Bedrock's error wording reaches the client** (`Value null at 'messages' failed to satisfy constraint`) | ts | 09-06 |
| F-10 | A `/v1/responses` request missing `input` is told to fix **`messages`** — a field that API does not have | ts | 09-06 |
| F-11 | `/v1/models` returns the full 53-model catalogue. Whether it filters by the key is **unverified** — LiteLLM's own error text tells clients to call it "to view available models for your key" | ts | 09-06 |
| F-12 | Chat completions return `id: ""` and `created: 0`. OpenAI always populates both | ts | 09-06 |
| LM-5 | A mid-stream error frame is not OpenAI-shaped, so an SDK consuming the stream cannot parse the failure | py | deferred — needs fault injection |
| F-13 | A prompt naming an unentitled server returns **502 on chat but 200 on Responses** — same condition, two answers | ts | stale |
| F-14 | `mcp_list_tools` is emitted only when a tool actually ran, so a client cannot discover what was offered | ts | stale |
| F-15 | A named `tool_choice` does not restrict the model to that tool | ts | stale |
| F-16 | `/v1` is not rate limited unless an RPM is explicitly set | ts | stale |
| F-17 | Budget headers round to 2 decimal places, so small spends read as zero | ts | stale |

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

## Coverage gaps — surfaces nobody tests

Neither repo covers these, so absence of findings here means absence of testing:
`/v1/messages` (what Claude Code uses — manual plan only, in
`claude-cli-gateway-testplan.md`), `/v1/completions`, `/v1/batches`, and token
counting. `/v1/moderations` and `/v1/models` are covered only by this repo;
`/v1/embeddings`, `/v1/files` and smart routing only by the Python suite.
