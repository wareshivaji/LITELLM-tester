# TokenShield vs LiteLLM — measured

Run on 2026-09-06 with `lab diff`, TokenShield Prod US against LiteLLM 1.100.0
on 127.0.0.1:4001. 15 cases: 13 compared, 2 not comparable.

Reproduce:

```bash
litellm --config reference/litellm/config.yaml --port 4001 --host 127.0.0.1
bin/lab diff -a https://gateway.cloudgov.ai -a-name tokenshield \
             -b http://127.0.0.1:4001      -b-name litellm \
             -a-header "Authorization: Bearer $TSLAB_KEY_PROD_TOOL_BLOCKING" \
             -b-header "Authorization: Bearer sk-1234" \
             -cases testdata/reference-cases.json
```

Every case in that file is free: none reaches a provider with a working
credential, so the run spends nothing. The cases that would spend live in
`testdata/reference-cases-spend.json` and are not run without asking.

## Why LiteLLM is the reference and not the judge

LiteLLM is a second real implementation of the same contract, which makes it
far better than my description of the contract. It is not automatically right.
Three of the differences below are LiteLLM defects, and two of the cases could
not be compared at all because of how this harness runs LiteLLM. Both are
recorded rather than dropped.

## What differs, and which side is wrong

### 1. The moderations error envelope is a string, not an object — TokenShield

`POST /v1/moderations`

| | status | `error` |
|---|---|---|
| TokenShield | 501 | a **string** |
| LiteLLM | 500 | an **object** |

This is LANDMINE-1, now confirmed against a second implementation rather than
against the OpenAI spec alone. It is the single most damaging difference here:
`{"error":"..."}` cannot be parsed by any OpenAI-shaped SDK, because every one
of them reads `error.message`. The client does not get a bad error — it gets an
exception while handling the error.

### 2. `messages` is not validated at the gateway; Bedrock's validator answers

`POST /v1/chat/completions` with no `messages`, and with `messages: []`:

- TokenShield: `Value null at 'messages' failed to satisfy constraint: Member must not be null`
- LiteLLM: `/chat/completions: Missing required parameter: 'messages'.`

TokenShield's string is AWS Bedrock's. Two consequences, and the second is the
one that matters: an obviously invalid request makes a provider round-trip, and
provider internals reach the client. A client cannot tell from that message
whether the gateway or the model provider rejected them.

### 3. A Responses error names a field the Responses API does not have

`POST /v1/responses` with no `input`:

- TokenShield: 400, `Value null at 'messages' failed to satisfy constraint…`
- LiteLLM: 500, `aresponses() missing 1 required positional argument: 'input'`

There is no `messages` field in the Responses API. A client debugging their
request is pointed at a field that does not exist in the API they are calling,
which is worse than an unhelpful message because it is plausible.

LiteLLM is also wrong here — a raw Python `TypeError` as a 500 — but its message
at least names the real field. Neither is right; TokenShield's is the more
misleading.

### 4. `/v1/models` means two different things

| | count | contents |
|---|---|---|
| TokenShield | 53 | the whole Bedrock catalogue, all `owned_by: cloudgov` |
| LiteLLM | 2 | only what this key can reach |

LiteLLM's own error text tells clients to "Call `/v1/models` to view available
models **for your key**". A client SDK that lists models so a user can pick one
will offer 53 on TokenShield, of which an unknown subset are actually callable.

### 5. MCP listings are shaped differently

`/v1/mcp/servers` (TokenShield) vs `/v1/mcp/server` (LiteLLM): different path,
and TokenShield returns an object where LiteLLM returns a bare array.

TokenShield's tool objects use `tool` and `input_schema`. The MCP specification
uses `name` and `inputSchema`. A client written against the MCP spec reads
neither field.

## Where TokenShield is the better of the two

Worth stating, because a reference comparison that only finds faults on one side
is not being read carefully.

- **Error fields are correct OpenAI values.** TokenShield returns
  `type: "not_found_error"`, `param: "model"`, `code: "model_not_found"`.
  LiteLLM returns `code: "400"` — the HTTP status as a string — and the literal
  string `"None"` for both `type` and `param`, which is Python's `None` having
  been stringified on its way into JSON. Verified directly, not inferred.
- **Unknown model returns 404**, which is OpenAI's status. LiteLLM returns 400.
- **No stack traces in error messages.** LiteLLM puts a Python traceback into
  `error.message` when `messages` is a string rather than an array.

## MCP tool policy is exposed correctly

`GET /v1/mcp/tools` returns all 9 tools with a per-tool `policy`, and the two
marked `block` — `hf_fs` and `microsoft_docs_fetch` — are exactly the two that
the live brokering run withheld from the model. Discovery and enforcement agree.

The raw diff line for this case reads `tools: 9 items vs 2`, which looks like
over-reporting and is not: LiteLLM has 2 tools configured, TokenShield has 9.

**This sharpens an earlier finding.** The management listing carries real
`input_schema` values — `hub_repo_search` has 6 properties, `hub_repo_details`
has 7. The brokered path was measured handing the model 7 tools with **no**
`input_schema` at all. So the gateway holds the schemas and drops them when
handing tools to the model. That is a larger problem than a missing field: the
model is asked to call tools whose arguments it cannot see.

## Not comparable

Two cases are marked `Skip` in the case file with their reason, rather than
deleted, so they are not re-added later and reported as findings:

- **no Authorization** and **a wrong key**. LiteLLM routes both through its
  DB-backed key lookup and, with no Postgres attached, answers 500 and
  `400 "No connected db."` respectively. That is this harness's setup, not
  LiteLLM's contract. Restore these cases only alongside a database.

## Still unmeasured

`testdata/reference-cases-spend.json` holds six cases that reach a provider:
LANDMINE-3 (`stop` as a bare string), the shorthand-input drop on Responses,
the declared `type:"mcp"` refusal status, named `tool_choice`, brokered MCP
schemas, and a baseline completion.

They are not run yet for two reasons. They spend against the $2/month budget on
the test key, and LiteLLM here has no provider credential — so for any case that
succeeds on TokenShield, LiteLLM would fail at the provider and the comparison
would show a transport difference rather than a contract one.

---

# Second run: the two refusal cases — and a correction

## Correction: LiteLLM had Bedrock credentials all along

The first write-up said LiteLLM "has no provider credential". That was wrong.
`~/.aws/credentials` exists on this machine and boto3 finds it without being
told, so LiteLLM answered real Bedrock calls throughout.

Two consequences. Every case in `reference-cases-spend.json` is comparable, and
the four marked not-comparable were marked on a false premise — their `Skip`
text now says so rather than being quietly deleted. And the two sides bill to
different places: TokenShield against the test key's $2/month budget, LiteLLM
against the local AWS account.

## Correction: both cases were predicted to be refused, and neither was

They were expected to cost nothing. Both returned 200, so the run cost roughly
$0.006 on the test key and $0.001 on the local AWS account. Small, but not the
zero that was predicted.

Both had previously been measured as refusals — 400 for the shorthand
tool-continuation, 403 for the declared `type:"mcp"` block. Both now return
200. That is consistent with active work on `responses.go`, and it means the
recorded expectations for these two are stale and need re-baselining.

## The finding: the key's MCP tools are injected into every request, and the
## client pays for them

| case | client sent | TokenShield input tokens | LiteLLM input tokens |
|---|---|---|---|
| tool-continuation | ~300-char body, one `adder` function tool | **2,700** | 651 |
| declared mcp block | one short user message | **2,593** | 12 |

The gap is the key's 7 allowed MCP tool definitions — measured at ~6,936
characters, ~1,734 tokens — plus framing, injected into requests that did not
ask for them. The second row is the sharper one: a 12-token request becomes
2,593 prompt tokens, a 200× multiplier, on every call made with an MCP-enabled
key.

This is key-driven brokering behaving as designed — the key is the trigger, not
the request. The finding is not that it happens but that it is unavoidable and
invisible: a client cannot opt out per-request, and nothing in the response says
why the bill is 200× the request.

## The declared MCP block is not honoured, not refused — it is substituted

The client declared `deepwiki`. TokenShield brokered its own key-configured
servers instead, and the model answered by listing `huggingface__hf_whoami` and
its siblings. So a client asking for server X silently receives servers Y and Z.

That is worse than OpenAI's documented 400 and worse than the 403 measured
earlier, because both of those tell the client something. Silent substitution
means a client believes it is talking to the server it named.

It also confirms once more that the `__` wire name is client-visible: it arrived
in the model's own text output.

## Output quality degraded on the injected-tools path

Asked "what is 2+2?" through the documented tool-continuation shape:

- LiteLLM: `2 + 2 = **4**`
- TokenShield: `I see I made an error in my previous response. Let me start fresh.\n\nHello! I`

Same model, same question. TokenShield's answer never addresses it. The likely
cause is the 7 unrelated MCP tools injected alongside a `function_call`
continuation for a different tool, but that is inference from one sample — it
needs a controlled repeat before it is treated as established.

---

# Re-baselining the three stale expectations (2026-09-06)

One held, one changed shape, one was never measuring what it claimed.

## 1. Responses shorthand tool-continuation — the refusal is gone, the defect is not

| | before | now |
|---|---|---|
| status | 400 "must start with a user message" | **200 `completed`** |
| answer | — | "I'm ready to help! It looks like I have access to several useful tools" |

The paired explicit-form control, sent in the same minute with the same model
and the same tool output:

> The current temperature in Paris is **21°C**

So the shorthand `{role, content}` turn is **still being dropped**. The model
never sees the question, so it introduces itself instead. The only thing that
changed is that the gateway stopped saying so — a silent wrong answer where
there used to be a loud refusal.

The expectation was `{ status: 200, verdict: 'ok' }` with a `notImplemented`
marker, the intent being that it would flip to `pass` once the shorthand was
honoured. **It would have flipped today, on a gateway that still drops the
turn** — a false green on a live defect, caused by asserting the status and
nothing else.

Both halves of the pair now assert `contains: '21'`. The tool output is the only
thing that can distinguish "the turn survived" from "the turn was dropped", and
a control that only checks for 200 controls for nothing now that both forms
return 200. `spends` also corrected to `true`: it costs ~2,707 input tokens.

## 2. The declared `type:"mcp"` block — the 403 was never the gateway's

Recorded as *"MEASURED 2026-09-02: 403 on both surfaces, 267ms — fast enough to
be pre-provider"*. It was not pre-provider. It was pre-*gateway*:

```
HTTP/1.1 403 Forbidden
Server: awselb/2.0
Content-Type: text/html
```

An HTML error page from the AWS load balancer, with no `x-request-id`. The
request carried `http://127.0.0.1:8789/mock-mcp` in its body and was rejected by
what is almost certainly an SSRF rule. TokenShield never saw it. The 267ms that
read as evidence of an early refusal was the edge answering.

The same request with a **public** `server_url` returns **200** and answers
normally — brokering the key's own HuggingFace / MS Learn / Cloudflare tools
instead of the server that was named. The declared block is neither honoured nor
refused: it is **silently substituted**. That is the outcome this case's own
`why` field already called the worst one.

The expectation is left as `refusedWith: [400, 403]` rather than weakened to
match. It now fails, and it should — 400 is documented, 403 would at least be
honest, and 200-with-substitution is neither.

**Structural consequence, beyond this one case.** The lab hands every
`declared`-mode case its own loopback mock as `server_url`. Against any remote
gateway that URL is blocked at the load balancer, so the whole `declared` group
measures the ALB rather than TokenShield. Those cases need a publicly reachable
`mcpServerUrl` before a Prod run of them means anything.

## 3. Brokered tools carry no `input_schema` — holds exactly

Confirmed on Prod US the same day. The `mcp_list_tools` item offers 7 tools and
every one of them has exactly three keys: `description`, `name`, `server_label`.
No schema on any. `server_label` is still the comma-joined
`'HuggingFace,MS Learn,Cloudflare docs'` for all seven.

The contrast is now measured rather than asserted: `/v1/mcp/tools` returns those
same tools **with** their schemas — 6 properties on `hub_repo_search`, 7 on
`hub_repo_details`. The gateway holds the schemas and drops them on the path
where the model needs them.

One thing worth not over-reading: the non-streaming item type here is `mcp_call`,
which is OpenAI's own name. The non-standard `mcp_tool_call` recorded earlier was
a *streaming event* name; that is a separate surface and has not been
re-measured.
