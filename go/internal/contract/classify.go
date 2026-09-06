package contract

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Envelope is which error shape came back.
//
// Which one it is IS a finding, so it is recorded separately from the verdict.
// The gateway emits three and only the first is parseable by an OpenAI SDK.
type Envelope string

const (
	EnvelopeNone      Envelope = "none"
	EnvelopeOpenAI    Envelope = "openai"    // {"error":{"message","type","code"}}
	EnvelopeAnthropic Envelope = "anthropic" // {"type":"error","error":{...}}
	EnvelopeFlat      Envelope = "flat"      // {"error":"a string"} — no OpenAI SDK parses this
)

// VerdictKind names what happened, as distinct from the status code.
//
// The point of this type is that a status code is not an answer: two different
// 429s and four different 403s mean different things and need different fixes.
type VerdictKind string

const (
	VerdictOK             VerdictKind = "ok"
	VerdictAuth           VerdictKind = "auth"
	VerdictBudget         VerdictKind = "budget"        // 429, a SPEND cap
	VerdictRateLimit      VerdictKind = "ratelimit"     // 429, requests per minute
	VerdictModelDenied    VerdictKind = "model-denied"  // 403, allowedModels
	VerdictNoCredential   VerdictKind = "no-credential" // 403, no provider credential
	VerdictIPBlocked      VerdictKind = "ip-blocked"    // 403, IP allowlist
	VerdictToolPolicy     VerdictKind = "tool-policy"   // 403, MCP tool policy
	VerdictGuardrail      VerdictKind = "guardrail"     // 400, NOT 403
	VerdictBadRequest     VerdictKind = "bad-request"
	VerdictNotFound       VerdictKind = "not-found"
	VerdictServerError    VerdictKind = "server-error"
	VerdictTransportError VerdictKind = "transport-error"
	VerdictUnknown        VerdictKind = "unknown"
)

// NormalizedError is the three envelopes flattened into one shape.
//
// Field presence mirrors the TypeScript exactly, including that Message is
// always emitted while the others are omitted when absent. The golden
// cross-check compares these structs, so a cosmetic difference here is a
// failure — which is correct: a consumer branching on `code` being present
// cares whether it is present.
type NormalizedError struct {
	Envelope   Envelope `json:"envelope"`
	Message    string   `json:"message"`
	Code       string   `json:"code,omitempty"`
	Type       string   `json:"type,omitempty"`
	BudgetName string   `json:"budgetName,omitempty"`
}

// Verdict is what happened and why, in terms a caller can act on.
type Verdict struct {
	Kind     VerdictKind `json:"kind"`
	Envelope Envelope    `json:"envelope"`
	Detail   string      `json:"detail"`
	Code     string      `json:"code,omitempty"`
	Type     string      `json:"type,omitempty"`
}

// Input is everything needed to classify one response.
type Input struct {
	Status         int
	Headers        map[string]string
	Body           json.RawMessage
	TransportError string
}

func asObject(raw json.RawMessage) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// str returns the value as a string only when it IS a string. A number or an
// object must not be coerced — a numeric `code` silently becoming "429" would
// make a branch match that should not.
func str(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

// DetectEnvelope reports which error shape a body is in.
func DetectEnvelope(raw json.RawMessage) Envelope {
	body := asObject(raw)
	if body == nil {
		return EnvelopeNone
	}
	switch err := body["error"].(type) {
	case map[string]any:
		// The Anthropic discriminator is the OUTER type, not anything inside
		// the error object — both envelopes nest under `error`, so checking
		// the inner shape first would mislabel every Anthropic error.
		if t, _ := str(body["type"]); t == "error" {
			return EnvelopeAnthropic
		}
		return EnvelopeOpenAI
	case string:
		_ = err
		return EnvelopeFlat
	}
	return EnvelopeNone
}

// NormalizeError flattens whichever envelope arrived.
func NormalizeError(raw json.RawMessage) NormalizedError {
	envelope := DetectEnvelope(raw)
	body := asObject(raw)
	if body == nil {
		return NormalizedError{Envelope: envelope}
	}

	if envelope == EnvelopeOpenAI || envelope == EnvelopeAnthropic {
		inner, ok := body["error"].(map[string]any)
		if !ok {
			return NormalizedError{Envelope: envelope}
		}
		out := NormalizedError{Envelope: envelope}
		out.Message, _ = str(inner["message"])
		out.Code, _ = str(inner["code"])
		out.Type, _ = str(inner["type"])
		out.BudgetName, _ = str(inner["budget_name"])
		return out
	}

	if envelope == EnvelopeFlat {
		out := NormalizedError{Envelope: envelope}
		// The human sentence is under `message`; when absent, the token in
		// `error` stands in for it. So both Message and Code can hold the same
		// string, which is deliberate rather than a bug.
		if m, ok := str(body["message"]); ok {
			out.Message = m
		} else if e, ok := str(body["error"]); ok {
			out.Message = e
		}
		out.Code, _ = str(body["error"])
		out.BudgetName, _ = str(body["budget_name"])
		return out
	}

	return NormalizedError{Envelope: envelope}
}

// Classify decides what happened.
//
// Branch ORDER is load-bearing and not merely stylistic:
//
//   - The guardrail check runs FIRST, before every status branch, because a
//     guardrail block is a **400**. Reaching the generic 400 branch first would
//     report every blocked prompt as a malformed request.
//   - Inside 403, the four cases are ordered most-specific first, and the
//     fall-through is `unknown` rather than `auth` — a 403 nobody recognises
//     should say so rather than assert an authentication problem it has not
//     established.
//   - `status >= 400` maps to bad-request before the final `unknown`, so an
//     unusual 4xx is still reported as a client-side rejection.
//
// Verified against the TypeScript implementation by golden_test.go rather than
// by reading — the first draft of this function looked correct and disagreed in
// eleven places.
func Classify(in Input) Verdict {
	if in.TransportError != "" {
		// No response at all, so no envelope and no gateway verdict. Calling
		// this a server error would blame the gateway for a connection that
		// never landed.
		return Verdict{Kind: VerdictTransportError, Envelope: EnvelopeNone, Detail: in.TransportError}
	}

	err := NormalizeError(in.Body)
	body := asObject(in.Body)
	haystack := strings.ToLower(err.Code + " " + err.Type + " " + err.Message)

	build := func(kind VerdictKind, detail string) Verdict {
		return Verdict{Kind: kind, Envelope: err.Envelope, Detail: detail, Code: err.Code, Type: err.Type}
	}
	or := func(msg, fallback string) string {
		if msg != "" {
			return msg
		}
		return fallback
	}

	if in.Status >= 200 && in.Status < 300 {
		return Verdict{Kind: VerdictOK, Envelope: err.Envelope, Detail: fmt.Sprintf("%d", in.Status)}
	}

	// Guardrails answer 400 with a flat envelope. Before the status branches.
	if err.Code == "guardrail_violation" || strings.Contains(haystack, "guardrail") {
		name := ""
		if body != nil {
			name, _ = str(body["guardrailName"])
		}
		if name != "" {
			return build(VerdictGuardrail, fmt.Sprintf("Blocked by guardrail %q", name))
		}
		return build(VerdictGuardrail, "Blocked by content guardrails")
	}

	switch {
	case in.Status == 401:
		return build(VerdictAuth, or(err.Message, "Missing or invalid API key"))

	case in.Status == 403:
		switch {
		case strings.Contains(haystack, "model_not_allowed"), strings.Contains(haystack, "not allowed for"):
			return build(VerdictModelDenied, or(err.Message, "Key allowedModels does not include this model"))
		case strings.Contains(haystack, "no_credential"), strings.Contains(haystack, "credential"):
			return build(VerdictNoCredential, or(err.Message, "No provider credential mapped for this key"))
		case strings.Contains(haystack, "ip"):
			return build(VerdictIPBlocked, or(err.Message, "Source IP not in the key allowlist"))
		case strings.Contains(haystack, "tool"):
			return build(VerdictToolPolicy, or(err.Message, "Tool policy refused this request"))
		}
		return build(VerdictUnknown, or(err.Message, "Forbidden (unclassified)"))

	case in.Status == 429:
		// TWO different 429s. A spend cap is fixed by raising a budget; a rate
		// limit by slowing down. Backing off on a budget rejection is wasted
		// time, and raising a budget for a rate limit does nothing.
		isBudget := err.Type == "insufficient_quota" ||
			err.Type == "billing_error" ||
			err.BudgetName != "" ||
			strings.Contains(haystack, "budget") ||
			strings.Contains(haystack, "quota")
		if isBudget {
			suffix := ""
			if err.BudgetName != "" {
				suffix = fmt.Sprintf(" (%q)", err.BudgetName)
			}
			return build(VerdictBudget, or(err.Message, "Spend cap reached")+suffix)
		}
		suffix := ""
		if retry := in.Headers["retry-after"]; retry != "" {
			suffix = " — retry after " + retry + "s"
		}
		return build(VerdictRateLimit, or(err.Message, "Per-minute RPM limit")+suffix)

	case in.Status == 404:
		return build(VerdictNotFound, or(err.Message, "No such route or resource"))

	case in.Status >= 500:
		return build(VerdictServerError, or(err.Message, fmt.Sprintf("Gateway returned %d", in.Status)))

	case in.Status >= 400:
		return build(VerdictBadRequest, or(err.Message, fmt.Sprintf("Rejected with %d", in.Status)))
	}

	return build(VerdictUnknown, or(err.Message, fmt.Sprintf("Unexpected status %d", in.Status)))
}
