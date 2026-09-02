# The LiteLLM / OpenAI contract the lab tests against

**This file, not the gateway, is the source of truth for expectations.**

Read from <https://docs.litellm.ai/docs/mcp> and
<https://docs.litellm.ai/docs/mcp_troubleshoot> on **2026-08-31**, and from the vendored
`openai@4.104.0` TypeScript definitions in `node_modules/openai/resources/`.

> **VERIFIED FROM SOURCE 2026-09-01.** LiteLLM is now cloned locally at `~/Cloudgov/litellm` —
> **v1.100.0**, branch `litellm_internal_staging`, HEAD `4db165379a` (*"fix mcp alias grant
> persistence"*). Several claims below were read from the code rather than the docs, and **two of
> them corrected an error of mine**. Anything still resting on docs alone says so. The checkout is
> 5,450 Python files and 2,551 test files, 72 of them MCP-specific.

Why it is separate from `GATEWAY_SURFACE.md`: that file records what *our* gateway does. This one
records what a client is **entitled to**. Keeping them apart is the whole point — measuring the
gateway against itself can only ever confirm it does what it does.

---

## 1. Correction to an earlier claim

I previously stated, twice and with confidence, that `/v1/chat/completions` has **no** MCP tool type
and therefore transparent brokering was the only conformant design there. That was read off the
`openai` SDK's own union, where the only tool type is `function`.

It is **wrong as a statement about LiteLLM.** LiteLLM accepts a `{"type": "mcp"}` block in `tools`
on `/chat/completions`:

```json
{ "type": "mcp",
  "server_url": "litellm_proxy/github/mcp",
  "server_label": "github_mcp",
  "require_approval": "never" }
```

So the correct statement is narrower: *OpenAI's own* chat-completions API has no MCP tool type, but
LiteLLM extends it, and a client following LiteLLM may declare MCP there directly.

**What LiteLLM does with it:** with `require_approval: "never"` the proxy *"automatically executes
the returned tool calls and feeds the results back into the model before returning the assistant
response"*. So the declaration is explicit and the brokering is transparent — both, not either.

## 2. Tool naming

> "LiteLLM namespaces multiple MCP servers by prefixing each tool name with its MCP server name."

**CORRECTED 2026-09-01 — the separator is a HYPHEN.** From
`litellm/proxy/_experimental/mcp_server/utils.py:53`:

```python
MCP_TOOL_PREFIX_SEPARATOR: Final = os.environ.get("MCP_TOOL_PREFIX_SEPARATOR", "-")
MCP_TOOL_PREFIX_FORMAT: Final = "{server_name}{separator}{tool_name}"
```

So the pattern is **`{server_name}-{tool_name}`**, and it is **configurable by environment
variable**. I previously read it as a single underscore, from the documented example
`github_mcp-search_issues` — but that is server `github_mcp`, then `-`, then tool `search_issues`.
The underscore was part of the server name, not the separator.

Two further details from source, both of which TokenShield lacks:

- **The separator is validated out of server names.** `utils.py:238` validates that a server name or
  alias does not contain the separator, because the round trip splits on the first occurrence
  (`utils.py:401`). TokenShield hardcodes `__` and does **not** validate, so a server whose name
  contains `__` yields a wire name that cannot be split back apart.
- **`LITELLM_USE_SHORT_MCP_TOOL_PREFIX`** swaps the human-readable server name for a deterministic
  short id, which is how LiteLLM keeps long names under the length cap. TokenShield instead
  truncates at 64 characters and appends a digest on collision.

`litellm_settings.mcp_aliases` maps friendly names (`github`) onto server names.

## 3. Headers

| Header | Meaning |
|---|---|
| `x-litellm-api-key` | proxy authentication |
| `x-mcp-servers` | which MCP servers this request may reach — **confirms** the scoping header |
| `x-mcp-{server_alias}-{header_name}` | per-server auth. The **recommended** form |
| `x-mcp-auth` | legacy, **deprecated** |
| `x-litellm-end-user-id` | end-user attribution for permissions and budgets |

`${X-HEADER_NAME}` maps an inbound HTTP header into a stdio server's environment.

Every one of these is already covered by the lab's `isSecretHeader` prefix rule (`x-mcp-`), so
per-server credentials are masked wherever the lab records them.

## 4. Endpoints

| Path | Purpose |
|---|---|
| `/mcp` | the MCP gateway itself |
| `/mcp-rest/tools/list`, `/mcp-rest/tools/call` | REST, for calling a tool with no LLM in the loop |
| `/v1/chat/completions` | accepts `type:"mcp"` tool blocks |
| `/v1/responses` | accepts `type:"mcp"` tool blocks |

Convention: when pointing LiteLLM at its own MCP gateway, `server_url` is the literal
`"litellm_proxy"` (optionally `litellm_proxy/{alias}/mcp`).

## 5. Access control

By API key, by team, by organisation, per-user via `x-litellm-end-user-id`, and a server-level
`allow_all_keys`.

**CORRECTED 2026-09-01 — per-TOOL blocking at key level DOES exist.** I stated twice that it had no
LiteLLM equivalent, and created the `cloudgov` reference value on that basis. That was wrong. From
`litellm/proxy/_experimental/mcp_server/auth/user_api_key_auth_mcp.py`:

```python
key_obj_perm.mcp_tool_permissions     # per-KEY, per-tool
team_obj_perm.mcp_tool_permissions    # per-TEAM, per-tool
allowed_tools = list(set(team_tools) & set(key_tools))   # line 2132 - intersection
```

There is also `get_allowed_tools_for_server`, `is_tool_allowed_for_server`, a **toolset** layer
(`resolve_toolset_tool_permissions`) and a user-level ceiling (`_apply_user_tool_ceiling`). The
`MCPServer` type carries **both** `allowed_tools` and `disallowed_tools`
(`mcp_server_manager.py:333-334`), and both are read straight from the config YAML (`:2137`) — so
tool blocking is testable there with no database at all.

Team intersected with key, narrower winning, is the same principle as TokenShield's org/key
combination.

**So `litellm` is a valid reference for tool governance.** What stays genuinely CloudGov-specific is
much narrower than I claimed: the per-tool **policy enum** (`ALWAYS_ALLOW`/`BLOCK`) whose single
stored value means a blacklist at org level and an allow-list at key level, plus the fail-open
default. LiteLLM models the same governance as explicit allow/deny **lists** instead.
`reference: 'cloudgov'` stays in the code for that narrower case — see AD-30 — but it must no longer
be justified as *"no external equivalent exists"*.

## 6. Error shapes — mostly undocumented

**ANSWERED FROM SOURCE 2026-09-01 — a denied tool is a 403.** From
`mcp_server_manager.py:4923`:

```python
raise HTTPException(
    status_code=403,
    detail={"error": f"Tool '{tool_name}' is not allowed for your key/team on server '{server.name}'. Contact proxy admin for access."},
)
```

So **403**, inside FastAPI's `detail` wrapper — `{"detail": {"error": "..."}}`. Not an OpenAI error
envelope, and `error` holds a human sentence rather than a machine-readable code.

**This is architecturally opposite to TokenShield, and neither is wrong.** TokenShield answers
**200** and tells the *model* the tool was blocked, because it **brokers** — the model asked for the
tool, so failing the client's request would punish a caller who made no mistake, and the model can
write around the gap instead. LiteLLM's default is passthrough, where the **client** called the
tool, so a 403 to that client is exactly right.

**The test this produces:** TokenShield's `POST /v1/mcp` surface *is* passthrough — there the client
calls directly. If a blocked `tools/call` on that route answers 200-with-refusal, that is the wrong
shape for that surface, and LiteLLM's 403 is the reference for it.

**`x-mcp-servers` fails closed.** `user_api_key_auth_mcp.py:99`: the header fails closed when it
introduces any server not in the path-derived target set, reasoned in the comment as a sign of a
confused or hostile caller. Same safe direction as TokenShield's matches-nothing-means-zero-servers
— but note TokenShield's `mcpAccess` mode fails **open** on an unrecognised value, which is the
opposite.

Still unread: what comes back when the MCP tool itself errors, or the server is unreachable. What
the troubleshooting guide shows:

- `HTTP/1.1 400 Bad Request` with **`{"detail":"invalid_request"}`** on OAuth redirect validation
  failure. Note the shape: FastAPI's flat `detail`, **not** an OpenAI error envelope. So LiteLLM
  itself is not OpenAI-shaped on this path, which weakens any argument that our gateway's flat
  envelopes are uniquely wrong — though it does not make them parseable by an OpenAI SDK.
- Connection failures surface as text: `"MCP client list_tools failed - Error Type: ExceptionGroup"`,
  `"httpx.ConnectError: All connection attempts failed"`.
- Debug headers `x-mcp-debug-oauth2-token: Bearer****ef01` and `x-mcp-debug-auth-resolution`. Note
  LiteLLM masks the token but keeps the **last four** characters.

**The security finding worth borrowing.** The guide warns that `SAME_AS_LITELLM_KEY` in the OAuth
token field means *the proxy's own API key is leaking to the MCP server* instead of a proper token.
That is a concrete, testable credential-leak mode: a gateway must not forward the customer's gateway
key to a third-party MCP server. The lab tests it with its own MCP server, which records exactly
what arrives — see `docs/PLAN-CLIENT-MCP.md`.

Because error shapes are undocumented, expectations about them cannot be `reference: 'litellm'`.
They are questions the lab answers by observation, and observations get `measured`.

## 7. The OpenAI Responses contract

From the vendored SDK, so checkable:

**Tool block:** `{type:'mcp', server_label, server_url}` required; `allowed_tools`
(`string[]` **or** `{tool_names}`), `headers`, `require_approval` (`'always' | 'never' | filter`)
optional.

**Output items:** `mcp_list_tools` (`id`, `server_label`, `tools[]`, `error?`) · `mcp_call` (`id`,
`name`, `arguments`, `server_label`, `output?`, `error?`) · `mcp_approval_request` (`id`, `name`,
`arguments`, `server_label`) · `mcp_approval_response`.

**Stream events — eight, exactly:**

```
response.mcp_call.in_progress       response.mcp_list_tools.in_progress
response.mcp_call.arguments_delta   response.mcp_list_tools.completed
response.mcp_call.arguments_done    response.mcp_list_tools.failed
response.mcp_call.completed
response.mcp_call.failed
```

TokenShield emits `mcp_tool_call`, which is none of these. An OpenAI-SDK stream parser does not
error on an unknown event — it **drops** it, so brokered tool work becomes invisible rather than
visibly wrong.

---

## What is still unanswered

| Question | Status |
|---|---|
| Aggregated tool namespacing | **From source** — `{server}-{tool}`, a **hyphen**, env-configurable, separator validated out of server names |
| Is `x-mcp-servers` the scoping header | **Answered** — yes |
| Unknown name in `x-mcp-servers` | **From source** — fails **closed** |
| Envelope for a **blocked** tool | **From source** — `403` + `{"detail":{"error":"..."}}` |
| Does per-key tool blocking exist in LiteLLM | **From source — YES**, correcting my earlier claim |
| Envelope for a **failing** tool or unreachable server | Still open. Not documented, not yet read |

## Mined from LiteLLM's test suite (Phase 4, 2026-09-02)

Read `tests/mcp_tests/test_aresponses_api_with_mcp.py` (1,703 lines, 11 tests) and
`tests/e2e/mcp/test_mcp_key_access_e2e.py`. Three checks came out of it that we did not have.

### 1. The Responses lifecycle has a fixed order, and we were missing an event

From `test_streaming_mcp_event_order_and_response_id_consistency`:

```
response.created -> response.in_progress -> response.output_item.added -> (MCP events) -> response.completed
```

**`response.in_progress` is required and we never looked for it.** We checked `created` and
`completed` and had no idea the middle event existed. Also asserted there: `output_item.added` must
precede `response.mcp_list_tools.in_progress`, because MCP events belong *inside* an output item
rather than floating between them.

Implemented as `checkResponsesLifecycle` in `stream.ts`, surfaced on the Streaming page.

### 2. Duplicate tool names — a brokering bug by nature

From `test_no_duplicate_mcp_tools_in_streaming_e2e`, whose docstring names the bug it guards:

> *"Parent function (aresponses_api_with_mcp) processed MCP tools once. Streaming iterator processed
> MCP tools again, causing duplicates."*

Any gateway that assembles a tool list in more than one place can double it, and a duplicated name
makes the model's choice ambiguous and unroutable back to one server. Now reported as
`duplicate-tool-name` by `checkMcpItems`.

### 3. Every offered tool needs name, description AND parameters

LiteLLM asserts all three on each tool handed to the model. We already flagged a missing
`input_schema`; **description was unchecked**. An empty description is how a model decides a tool
does not apply, so it is near-unusable. Now `missing-description`.

Finding one of our own test fixtures immediately: the `single-server label` case in
`mcpItems.test.mjs` had a tool with no description and expected a clean result. The fixture was
incomplete, not the check wrong.

### Where we deliberately do NOT follow LiteLLM

Their id test groups events into **cycles** and only requires the response id to be consistent
*within* a cycle — because a two-round LiteLLM conversation emits **two** `response.created` and
**two** `response.completed` with two different ids in one stream. That is not the shape a Responses
stream is defined to have, and a client tracking one response id breaks on it.

Our check asserts exactly one `created`, one `completed`, and one id throughout, which is what our
broker reconciles to. The walkthrough's Appendix B.3 already names one-response-lifecycle as an axis
where TokenShield is ahead. **Do not relax this to match LiteLLM.** A unit test pins the divergence
so nobody "fixes" it by accident.

### 4. Per-server credentials: the convention, and a hyphen trap

From `test_aresponses_api_with_mcp_passes_mcp_server_auth_headers_to_process_tools`. Its fixture is
one header and one asserted result:

```
x-mcp-linear_config-authorization: Bearer linear-token
        ->  { linear_config: { Authorization: 'Bearer linear-token' } }
```

Three things fall out.

**The alias and the header split on the FIRST hyphen after the prefix.** So an alias containing a
hyphen silently becomes a different server: `x-mcp-linear-config-authorization` parses as alias
`linear`, header `Config-Authorization`. LiteLLM's own example alias uses an **underscore** for
exactly this reason, and it validates separators out of server names elsewhere in the codebase. A
gateway that accepts a hyphenated alias will route a credential to a server that does not exist, and
nothing will say so.

`buildMcpAuthHeader` therefore **throws** on a hyphenated alias rather than emitting a header that
will be mis-parsed downstream.

**Header names are title-cased** on the way through: `authorization` becomes `Authorization`,
`x-api-key` becomes `X-Api-Key`.

**Credentials are scoped per server.** Each alias gets its own map, so a token meant for server A
must never reach server B. `checkMcpAuthScoping` turns that into a lookup against what the lab's own
MCP server actually received.

Also worth noting: LiteLLM carries these in a `secret_fields.raw_headers` container rather than
alongside ordinary headers — they are explicitly segregated as secrets at the type level.

**Two prefixed headers are NOT per-server credentials** and must not be parsed as such: the legacy
`x-mcp-auth`, and the scoping header `x-mcp-servers`. Treating either as one invents a server called
`auth` or `servers`.

Verified live against the lab's MCP server: two servers' credentials group correctly to
`{books: [Authorization], docs: [Authorization]}`, a planted `cg-ak-` gateway key is reported as
leaked via `authorization`, and **no credential value appears anywhere in the report**.

### Not yet mined

`test_mcp_allowed_tools_filtering`, `test_mcp_output_elements_addition`, and the two
`TestMcpKeyGrantByAlias` / `TestMcpKeyWithoutAccessIsDenied` e2e classes.

## What LiteLLM actually is, and where to mine it

It is a **gateway**, not a testing tool — the same category as TokenShield, not the same category as
this lab. It ships three things: a Python SDK (`import litellm`), a FastAPI proxy, and a Next.js
admin UI mounted at `/ui` (`proxy_server.py:2042`).

The part worth mining is its **tests**, which are pytest. `~/Cloudgov/litellm/tests/` holds 2,551
files, 72 MCP-specific. The two closest to the branch under test:

- `tests/mcp_tests/test_aresponses_api_with_mcp.py` — Responses API with MCP, the exact surface
- `tests/e2e/mcp/test_mcp_key_access_e2e.py` — per-key MCP access, end to end

That is the nearest thing that exists to an OpenAI-compatibility conformance corpus for this
surface.
