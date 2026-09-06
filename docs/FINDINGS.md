# TokenShield — what a compliant client hits

Written for whoever fixes the gateway. Every entry is something an
OpenAI-shaped or LiteLLM-shaped client runs into without doing anything unusual.

**Read the confidence column first.** Two of the three findings re-checked on
2026-09-06 had already changed since 2026-09-02, so anything not re-verified
since the Responses work landed should be treated as a lead, not a fact.

| | confidence |
|---|---|
| **Confirmed 09-06** | measured on Prod US on 2026-09-06, several against LiteLLM as a second implementation |
| **Stale 09-02** | measured once on 2026-09-02 and not re-checked. The two that were re-checked both moved |

Reproductions assume `bedrock-claude-haiku-4.5` on Prod US with an MCP-enabled
key. `bin/lab diff -cases testdata/reference-cases.json` reproduces the
error-envelope group in one command and spends nothing.

---

## P0 — a compliant client is broken, not merely inconvenienced

### 1. The moderations error envelope cannot be parsed by any OpenAI SDK

**Confirmed 09-06** · `POST /v1/moderations`

Returns `{"error": "some string"}`. Every OpenAI-shaped SDK reads
`error.message`, so the client does not receive a bad error — it throws inside
its own error handler, turning a clean 501 into an unhandled exception.

LiteLLM returns `{"error": {"message": ..., "type": ...}}` for the same call.
Three SDK attempts were made against this and all three failed.

*Fix:* return the object form. The cheapest high-impact change on this list.

### 2. `/v1/responses` silently drops the shorthand user turn

**Confirmed 09-06** · `POST /v1/responses`

OpenAI's documented tool-continuation uses `{role, content}` input items. Send
one alongside `function_call` / `function_call_output` items and the user turn
disappears. The model never sees the question.

```
shorthand {role, content}   ->  "I'm ready to help! It looks like I have access to several useful tools"
explicit  {type:"message"}  ->  "The current temperature in Paris is 21C"
```

Same model, same tool output, same minute. This previously returned 400
*"A conversation must start with a user message"*; it now returns **200**. The
refusal was fixed, the drop was not — and a silent wrong answer is worse than
the refusal, because the 400 at least told the client something was wrong.

*Fix:* normalise the shorthand item to the explicit form before the tool items
are processed. The explicit path already works, which is the proof that only
the normalisation is missing.

### 3. A declared `type:"mcp"` block is silently substituted

**Confirmed 09-06** · `POST /v1/chat/completions`, `POST /v1/responses`

Declare an MCP block naming server X. The gateway ignores it and brokers the
key's own configured servers instead, answering 200 as though nothing happened.
A client that believes it scoped the request to one server has in fact reached
two others.

OpenAI documents 400 for this. Even a 403 would be defensible. 200-with-
substitution is neither, because nothing tells the client its scoping was
discarded.

*Fix:* refuse with 400 naming the unreachable server. If honouring the block as
a narrowing filter is intended that is fine too — but then it must actually
narrow, and an unmatchable label must still be an error.

---

## P1 — costs money, or misleads in a way that costs debugging time

### 4. MCP tool definitions are injected into every request on an MCP-enabled key

**Confirmed 09-06**

| client sent | billed prompt tokens |
|---|---|
| one short user message (12 tokens through LiteLLM) | **2,593** |
| ~300-byte body declaring one unrelated `function` tool | **2,700** |

The gap is the key's 7 allowed tool definitions, measured at 6,936 characters
(~1,734 tokens), added to requests that never asked for tools. A trivial call is
billed at roughly 200x its own size.

This is key-driven brokering working as designed — the key is the trigger, not
the request — so the finding is not that it happens. It is that a client cannot
opt out per-request and nothing in the response explains the multiplier.

*Fix:* at minimum report the injected token count separately in `usage`, so the
bill is explicable. Better: honour a per-request opt-out.

### 5. Brokered tools reach the model with no `input_schema`

**Confirmed 09-06**

`mcp_list_tools` offers 7 tools, each carrying exactly `description`, `name`,
`server_label`. No schema on any of them, so the model is asked to call tools
whose arguments it cannot see.

The gateway is not missing the schemas — `GET /v1/mcp/tools` returns the same
tools *with* them the same day (6 properties on `hub_repo_search`, 7 on
`hub_repo_details`). They are dropped on the path where they matter.

*Fix:* pass `input_schema` through to the brokered listing. The data is already
loaded.

### 6. `mcp_list_tools.server_label` names every server at once

**Confirmed 09-06**

All 7 tools report `server_label: "HuggingFace,MS Learn,Cloudflare docs"` — a
comma-joined string rather than the server each tool belongs to. A client cannot
tell which server it is about to call.

*Fix:* set the label per tool.

### 7. Tool output is truncated at ~4,032 characters

**Stale 09-02** · documented limit is 120,000

The truncation is not only shown to the client — the **model** received the
truncated result and answered from it. 4,032 is suspiciously close to the chat
SSE preview cap of 4,000, so this looks like a chat-path constant leaking onto
Responses.

*Not re-verified.* A brokered call on 09-06 returned 2,840 characters and so did
not reach the cap.

### 8. An auth-store failure looks like a gateway bug and triggers a retry storm

**Stale 09-02**

When the auth store is unavailable: **500 after ~5.15s**, with no `Retry-After`
and no `x-should-retry`. The `openai` SDK therefore retries 3x — about 15.5
seconds of hanging — and monitoring attributes a dependency outage to the
gateway.

*Fix:* 503 with `Retry-After`, and set `x-should-retry` explicitly.

### 9. The gateway hands its own brokered tool back to the client

**Stale 09-02**

In a mixed turn — a client tool plus the key's MCP tools — the client received a
`tool_calls` entry for `huggingface__hub_repo_search`, a tool it never declared
and cannot execute. Handing the whole turn back is deliberate; handing back a
call the client cannot possibly satisfy leaves it with nothing sensible to do.
The mixed case was prod-confirmed to deadlock.

This is also where the `__` wire name becomes client-visible, which it should
not be.

### 10. `stop` as a bare string produces a blank stop sequence

**Stale 09-02** · LANDMINE-3

OpenAI accepts `stop` as either a string or an array. The string form is
mishandled and yields an empty stop sequence rather than the one requested.

---

## P2 — contract divergences worth fixing, survivable in the meantime

| # | finding | confidence |
|---|---|---|
| 11 | `messages` is not validated at the gateway; an invalid request round-trips to Bedrock and **Bedrock's error wording reaches the client** (`Value null at 'messages' failed to satisfy constraint`) | Confirmed 09-06 |
| 12 | A `/v1/responses` request missing `input` is told to fix **`messages`** — a field that API does not have | Confirmed 09-06 |
| 13 | `/v1/models` returns the full 53-model catalogue, not what the key can call. LiteLLM's own error text tells clients to call it "to view available models **for your key**" | Confirmed 09-06 |
| 14 | Chat completions return `id: ""` and `created: 0`. OpenAI always populates both | Confirmed 09-06 |
| 15 | A prompt naming an unentitled server returns **502 on chat but 200 on Responses** — same condition, two answers | Stale 09-02 |
| 16 | `mcp_list_tools` is emitted only when a tool actually ran, so a client cannot discover what was offered | Stale 09-02 |
| 17 | A named `tool_choice` does not restrict the model to that tool | Stale 09-02 |
| 18 | `/v1` is not rate limited unless an RPM is explicitly set | Stale 09-02 |
| 19 | Budget headers round to 2 decimal places, so small spends read as zero | Stale 09-02 |

---

## Where TokenShield is ahead of LiteLLM

Included because a list that only finds fault is not being read carefully, and
because these should not be "fixed" toward the reference.

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
(`Server: awselb/2.0`, no `x-request-id`) for any request whose **body**
contains a loopback URL such as `http://127.0.0.1:8789/...` — an SSRF rule. The
gateway never sees the request.

This sat in our own notes for four days as a gateway finding: *"403, 267ms, fast
enough to be pre-provider"*. It was the edge answering. Any test that puts a
local MCP server URL in a request body is measuring the load balancer.
