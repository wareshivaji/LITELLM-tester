// Package contract holds what a client is entitled to expect from the gateway.
//
// # G1's premise did not survive contact
//
// The plan for this phase said: port the contract modules to Go so they can
// **import the gateway's own types**, deleting the transcription drift that
// produced three separate corrections in one session — the wire-name separator,
// whether LiteLLM has per-key tool permissions, and 400-versus-403 on a
// stripped MCP block.
//
// That is not achievable, for two reasons found by trying it.
//
//  1. **Toolchain.** The gateway's `go.mod` requires Go 1.25.0; the toolchain
//     here is 1.22.2. `go build` refuses before it reaches any import.
//     Fixable by upgrading, but it is not the real blocker.
//  2. **`internal/`, which is not fixable from this side.** The gateway module
//     is `cloudgov.ai/ai-gateway` and every contract type lives under
//     `internal/` — `internal/apierror`, `internal/mcp`. There is no `pkg/`.
//     Go permits importing an `internal` package only from within the subtree
//     rooted at its parent, and that is enforced by the compiler rather than by
//     convention. A separate module cannot import them at all, `replace`
//     directive or not.
//
// So the honest options were: get the gateway to expose a `pkg/contract`; move
// this lab inside the gateway repo; transcribe again in a new language and gain
// nothing; or the fourth one, taken here.
//
// # Extract and verify
//
// The contract is still written out in Go — but every value that came from
// gateway source records **where it came from**, and a test re-reads that
// source and fails when it no longer says what we recorded.
//
// That does not make drift impossible the way an import would. It makes drift
// **loud**, which is the actual problem: all three corrections this session were
// not "someone wrote the wrong thing", they were "the source changed and nobody
// noticed for weeks". A failing test on the next gateway edit closes that gap
// without needing anything from another team.
//
// If the gateway later exposes a `pkg/contract`, `sourcecheck.go` is deleted and
// these constants become imports. The extraction is scaffolding for that, not a
// destination.
//
// # Verified against the TypeScript, not merely compiled
//
// The TypeScript implementation has 340 passing tests and is the incumbent. So
// this package is not trusted because it looks right: `golden_test.go` reads
// the same JSON fixtures the TS tests use and asserts identical results. A port
// that compiles and disagrees is worse than no port, because it looks finished.
package contract
