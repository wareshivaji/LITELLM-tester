# User guide

What each page is for, and how to convince yourself it works.

Start the lab:

```bash
cd ~/Cloudgov/tokenshield-client-sdk
npm run dev
```

Open **http://127.0.0.1:5173**. Stop it with **Ctrl+C in that terminal** — not `kill-port`.
`npm run dev` runs `concurrently`, which supervises `tsx watch` and `vite`: kill the process
holding a port and the supervisor immediately starts a replacement.

Two things are true on every page:

- **The target strip at the top** always names the gateway, the key alias and the auth header the
  next call will use. If you only read one thing before believing a result, read that.
- **The exchange log at the bottom** records every call the lab has made this session. Click any
  row for the full request, the response headers with the gateway's own signal highlighted, and
  **copy as curl** to reproduce it elsewhere.

Anything that reaches a provider says **"real tokens, real spend"** next to the button. Everything
else is free.

---

## 1 · Connect

**What it is for.** Answering "can I use this gateway with this key, right now?" before you waste
time on anything else.

**Try this.**

1. Pick a profile and a key, press **Run preflight**. Six checks, no provider call, costs nothing.
2. Look at **Models available to this key** — that is the key's real `allowedModels`, not the
   gateway's full catalogue. Two keys on the same org will show different lists.
3. Press **+ add** next to *Gateway*, enter a label and `https://gateway-mumbai.cloudgov.ai`, and
   preflight it. It appears immediately — no restart.
4. **Reload the page.** The gateway you added is still there, because the backend holds it and the
   tab holds nothing. Now restart the backend and it is gone — session targets are memory-only, and
   the dropdown says so.
5. Try adding a key whose alias already exists. It is **refused**, not silently preferred.

6. Read **MCP servers and tools for this key**. This is the sixth check, and it is free — 
   `GET /v1/mcp/servers` generates nothing. It answers *which servers, and which tools on them*,
   with the policy on each: `allow` in green, `block` in red, `ask` in amber.

   Two things make this the authoritative view. It goes **live on every call** rather than reading
   the gateway's 60-second cache. And unlike the `mcp_list_tools` item in a response, it appears
   whether or not a tool ran — that item is only emitted when the gateway actually brokers
   something, so it cannot answer "what does this key have".

   The blue name beside each tool is the **wire name** — `huggingface__hub_repo_search` — which is
   what the model is shown and what a refusal names. It is **derived here**, because the gateway
   returns it nowhere: both MCP endpoints, the `mcp_list_tools` item and `mcp_call` all report the
   upstream name instead. Copy it to force a call to a blocked tool and check the refusal says
   `policy_block` rather than `unknown_tool`.

   A key with servers but **zero usable tools** is called out on its own line — that integration
   will look broken to whoever configured it, and nothing else in the console says why.

**What good looks like.** Six green checks, a model list matching what you expect that key to have,
and an MCP tool list whose blocked entries are the ones you blocked.

---

## 2 · Playground

**What it is for.** Sending one request to any tested surface and seeing exactly what came back.

> **Scope narrowed 2026-09-02.** The tested surfaces are `/v1/chat/completions`, `/v1/responses`,
> and the two MCP endpoints. The Anthropic surface, text completions, embeddings and moderations
> were removed — the gateway is not being held to those, so findings there were not going to be
> acted on. The token counter is still called as a free *instrument* for the allowedModels gate,
> but it is no longer a tab.

**Try this.**

1. Leave it on *Chat Completions*, press **Send**. You get the text, the token usage, the finish
   reason, and below that the full exchange.
2. Click a **probe** chip — say `stop as string ⚠`. It patches the body below and tells you what it
   is asking and what today's gateway is believed to do. Send it: you should get a 400, because that
   is a real bug. The `⚠` means *known broken*; if a `⚠` probe ever succeeds, something got fixed.
3. Edit the **request body** directly. It is the source of truth and is sent verbatim — nothing
   validates or "corrects" it, which is the only way to find out how the gateway answers a malformed
   request. Break the JSON and **Send** disables itself with the parser error.
4. Apply the `guardrail trip` probe and send. A guardrail block comes back as a **400** carrying a
   flat `{"error":"string"}` body — an envelope no OpenAI SDK can parse. This used to be shown on
   Moderations, which returned a 501 in the same shape; that surface is out of scope now, but the
   flat envelope is still reachable here, which is what matters.
5. Press **copy as curl** on any exchange. The credential comes out as `$TOKENSHIELD_KEY`, never the
   real or masked value, so it is safe to paste into a ticket.

---

## 3 · Streaming

**What it is for.** A streamed response is a shape over time, not one answer. This page shows the
shape.

**Try this.**

1. Prompt is already "Count from 1 to 20". Press **Stream**. Watch the text arrive.
2. Read **Timing**: when the first frame arrived, when the first *token* arrived, the longest stall.
3. Read **Frame timeline**: every frame, with an inline bar sized to the gap before it. A stall is
   visible without reading numbers.
4. Read **Conformance**. On a normal chat stream you will see most frames flagged for an empty `id`
   and `created: 0`. The text is fine; a strict client is not. This is the panel that finds things
   nobody notices.
5. Start a long stream and press **Stop**. Whatever arrived is kept, and the exchange records how
   far it got — including the gateway's `X-Request-ID`, which is the handle for asking whether it
   still billed.
6. Switch to *Messages (Anthropic)* and stream. Watch for a `200` followed by an `event: error`
   frame — a success status carrying a failure.
7. If the gateway ran MCP tools for you mid-stream, a **Tools the gateway ran for you** panel
   appears, built from `mcp_tool_call` frames — the only client-visible account of work the gateway
   brokered on your behalf. A call that starts and never finishes shows as
   `running (never completed)` rather than being dropped, because silently omitting it would report
   a hung tool as no tool at all.

---

## 4 · SDK compare

**What it is for.** Raw HTTP shows the response body. Only a real SDK shows what a developer's
`catch` block actually receives.

**Try this.**

1. Leave *raw HTTP* and *openai* both selected, press **Send via 2 clients**. The headline says
   **clients agree** or **clients disagree**.
2. Switch the surface to *Moderations* and send again. Both get a 501, but the openai card shows you
   what the customer sees: `InternalServerError`, no `type`, no `code`, and a quoted JSON string as
   the message.
3. Set **SDK maxRetries** to 2 and send Moderations again. **Three attempts.** A 501 is retryable
   under the SDK's rules, and `openai`'s default is 2 — so a permanently unsupported endpoint costs
   three round trips before failing.
4. Apply the `stop as string ⚠` probe and send via openai. That is what a developer sees for that
   bug: a Bedrock message about `inferenceConfig.stopSequences` for a perfectly legal OpenAI request.
5. Note the **headers this SDK added** — eight `x-stainless-*`. Real customer traffic carries these.

---

## 5 · Governance

**What it is for.** The rejections that are *supposed* to happen, and whether they arrive in a form
a client can act on.

**Try this.**

1. **Mint a disposable key.** Needs a `cg-mk-` management key configured. Give it a name, a tiny
   budget (`0.0001`), one day's expiry. It is registered and selected automatically, and its raw
   value never reaches the page.
2. With that key selected, go to the Playground and send a few chat requests with `max_tokens: 900`.
   Around the third you get a **429** — `insufficient_quota`, `key_budget_exceeded`, with
   `spend_usd`, `limit_usd` and `budget_name` in the body. The console names it `budget`, not
   `ratelimit`.
3. Mint another with `ip_allow_list` = `203.0.113.0/24` and use it: `403`, "Your IP address is not
   allowed", classified `ip-blocked`.
4. Mint one with `allowed_models` = `bedrock-nova-micro`, then call a different model: `403
   model_not_allowed_for_key` naming the refused model.
5. Press **Trip it** on the *allowedModels* card. It probes eight cross-provider model ids using the
   token counter, which generates nothing — so it is free. `404` means the gateway does not route
   that model; `403 model-denied` means it does and this key may not use it. Only the second
   exercises the gate.
6. Press **Trip it** on *Rate limit*. It bursts 80 free requests. On a key with no RPM configured it
   will **not** fire — which is itself the finding.

Cards state whether they **spend**, and what they need before they can be tested at all.

---

## 6 · Tools & MCP

**What it is for.** One reply takes two or three HTTP requests when tools are involved. This runs
the whole conversation.

**Try this.**

1. Leave `get_weather` selected, press **Run tool loop**. You get a turn timeline: turn 1 offers the
   tool and comes back `finish_reason: tool_calls`; the lab executes it locally; turn 2 sends the
   result and the model answers using it.
2. Select **both** tools and ask for weather *and* time. Two calls in a single turn, each with its
   own id and parsed arguments.
3. Set **tool_choice** to *force get_time* while asking about the weather. It should call only
   `get_time`. It calls **both** — naming a tool does not restrict to it.
4. Set it to `none` (prose, no calls) and `required` (a call is forced even for "Say hello").
5. **Switch the surface to `/v1/responses`** and run the loop again. Same conversation, different
   shapes at every step: the tool is declared flat instead of nested under `function`, the call
   comes back as a `function_call` item inside `output[]`, and the continuation goes back as
   `input[]` items keyed by `call_id`. Tick **send the other surface's tool shape** to make the
   realistic client mistake on purpose — reusing a chat tool definition on Responses.
6. Press **List servers & tools**. If any exist you get a policy count per tool — `allow` / `block`,
   with `ask` highlighted if present, because the gateway still advertises that value for a state
   its enforcement model no longer has. Each server gets a **test reachability** button, which is
   the only honest answer to "is this server up?" as distinct from "does the gateway list it",
   which it will do either way. If you get `{"servers":[]}`, note that this endpoint cannot
   distinguish "none configured" from "discovery failed" — both look like an empty list.

---

## 7 · Scenarios

**What it is for.** The Playground answers "what does this do?". A scenario answers "is it still
doing what it did last week?".

**Try this.**

1. Pick **Client conformance** and press **Run suite**. Results stream in.
2. Look at the outcomes. You should get several `pass` and **two `landmine`** rows. A landmine row
   matching is the *expected* state for a known defect — it means the bug is still there. **An
   all-green suite here would be suspicious, not reassuring.**
3. Untick *include scenarios that reach a provider* and run again — the free subset only.
4. Set **Compare against** to a second gateway and run. Every row is labelled with its target. If
   the key is not valid on that gateway you get `blocked` rows, not fake failures: the target
   refused the request, so nothing was measured and you should draw no conclusion.
5. Press **Export to out/**. A JSON and a Markdown report land in `out/`, each stamped with target,
   base URL, key alias and model. The Markdown is ready to paste into a ticket.

**Reading the outcomes:**

| Outcome | Means |
|---|---|
| `pass` | Behaved as a client is entitled to expect |
| `FAIL` | Did not — investigate |
| `landmine` | A known defect, still present. Expected |
| `CHANGED` | A known defect stopped behaving that way. Probably fixed — go look |
| `not yet` | A feature still being built. The expectation states the *target*, so this is the expected state — and when such a row turns `pass`, the feature landed |
| `blocked` | The target refused the request outright. Nothing was measured |
| `error` | No response at all |

Every row also carries a small **reference** chip saying where its expectation came from, because
that is the difference between "the gateway is wrong" and "we assumed something":

| Chip | Means |
|---|---|
| `openai` | OpenAI's published behaviour — the contract clients are actually written against |
| `mcp-spec` | The MCP specification: handshake order, JSON-RPC result shapes |
| `litellm` | The compatibility target. **Not** verified against a local LiteLLM here — documented behaviour, pending confirmation |
| `measured` | Only what this gateway was observed doing once. It cannot tell you that behaviour is *correct*, so a `measured` row that starts failing means something *changed* |

The **MCP** suite is written entirely against `mcp-spec`, not against what the gateway currently
does, because that implementation is still landing. A `not yet` row there is the expected state and
is not a defect.

---

## Where to look when something is odd

- **`ECONNREFUSED — nothing is listening at http://localhost:4000`** — the local gateway is not
  running.
- **Everything 500s with a 5-second delay** — the gateway is up but cannot reach its auth store.
- **The exchange log emptied by itself** — you edited the SDK; rebuilding restarts the backend and
  history lives in that process.
- **A governance change has not taken effect** — the gateway caches keys and credentials for 900 s
  by default.

More detail in [RUNBOOK.md](RUNBOOK.md). Why it is built this way is in
[ARCHITECTURE.md](ARCHITECTURE.md).
