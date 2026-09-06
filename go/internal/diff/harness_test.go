package diff

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func backend(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func jsonBackend(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return backend(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}

func runOne(t *testing.T, a, b *httptest.Server, c Case) CaseReport {
	t.Helper()
	r := NewRunner(Target{Name: "a", BaseURL: a.URL}, Target{Name: "b", BaseURL: b.URL})
	return r.Run(context.Background(), c)
}

func TestAgreeingBackendsReportSame(t *testing.T) {
	body := `{"profiles":[{"id":"local"}],"keys":[]}`
	rep := runOne(t, jsonBackend(t, 200, body), jsonBackend(t, 200, body),
		Case{Name: "config", Method: http.MethodGet, Path: "/api/config"})

	if !rep.Same {
		t.Errorf("want same, got %+v", rep.Body.Differences)
	}
	if rep.StatusDiffers {
		t.Error("statuses were equal")
	}
}

// A body-only diff would miss this, and it is a real break: same payload,
// different status means a client's error handling diverges completely.
func TestSameBodyDifferentStatusIsNotSame(t *testing.T) {
	body := `{"error":{"message":"nope"}}`
	rep := runOne(t, jsonBackend(t, 403, body), jsonBackend(t, 400, body),
		Case{Name: "refusal", Method: http.MethodGet, Path: "/x"})

	if rep.Same {
		t.Fatal("a status difference must not be reported as same")
	}
	if !rep.StatusDiffers {
		t.Error("StatusDiffers should be set")
	}
	if !rep.Body.Same {
		t.Errorf("the bodies were identical: %v", rep.Body.Differences)
	}
	if !strings.Contains(Summary{Reports: []CaseReport{rep}}.Text(), "status: a=403 b=400") {
		t.Error("the rendered report does not show the status difference")
	}
}

func TestBodyDifferencesAreReportedWithPaths(t *testing.T) {
	rep := runOne(t,
		jsonBackend(t, 200, `{"tools":[{"name":"a","policy":"allow"}]}`),
		jsonBackend(t, 200, `{"tools":[{"name":"a","policy":"block"}]}`),
		Case{Name: "tools", Method: http.MethodGet, Path: "/x"})

	if rep.Same {
		t.Fatal("want a difference")
	}
	if got := rep.Body.Differences[0].Path; got != "tools.0.policy" {
		t.Errorf("path = %q", got)
	}
}

// One backend being down must never look like agreement, even though two empty
// bodies compare equal — that is exactly how a migration gets waved through
// against a backend that was not running.
func TestATransportFailureIsNeverSame(t *testing.T) {
	up := jsonBackend(t, 200, `{}`)
	down := Target{Name: "b", BaseURL: "http://127.0.0.1:1"}

	r := NewRunner(Target{Name: "a", BaseURL: up.URL}, down)
	rep := r.Run(context.Background(), Case{Name: "x", Method: http.MethodGet, Path: "/x"})

	if rep.Same {
		t.Fatal("a backend that did not answer must not compare as same")
	}
	if rep.B.Error == "" {
		t.Error("the transport error was not recorded")
	}
	if !strings.Contains(Summary{Reports: []CaseReport{rep}}.Text(), "b:") {
		t.Error("the rendered report does not name the failing target")
	}
}

func TestVolatileFieldsDoNotDefeatTheRun(t *testing.T) {
	rep := runOne(t,
		jsonBackend(t, 200, `{"id":"a1","durationMs":11,"ok":true}`),
		jsonBackend(t, 200, `{"id":"b2","durationMs":97,"ok":true}`),
		Case{Name: "preflight", Method: http.MethodGet, Path: "/x"})

	if !rep.Same {
		t.Errorf("ids and timings should not differ meaningfully: %v", rep.Body.Differences)
	}
}

func TestPerCaseVolatilityIsAdditiveNotReplacing(t *testing.T) {
	// A case declaring its own volatile path must still get the defaults, or
	// every case would have to restate ids and timings.
	rep := runOne(t,
		jsonBackend(t, 200, `{"id":"a","nonce":"n1","ok":true}`),
		jsonBackend(t, 200, `{"id":"b","nonce":"n2","ok":true}`),
		Case{
			Name: "x", Method: http.MethodGet, Path: "/x",
			Volatile: []Volatile{{"nonce", "per-call nonce"}},
		})

	if !rep.Same {
		t.Errorf("want same — defaults plus the case's own: %v", rep.Body.Differences)
	}
}

// ── the request actually sent ───────────────────────────────────────────────

func TestBothTargetsGetTheSameRequest(t *testing.T) {
	// If the two backends are not asked the same thing, the comparison is
	// meaningless — and it would be meaningless in a way that looks like a
	// finding.
	seen := map[string]string{}
	record := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			buf := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(buf)
			seen[name] = r.Method + " " + r.URL.Path + " " + string(buf) + " auth=" + r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}
	}
	a := backend(t, record("a"))
	b := backend(t, record("b"))

	r := NewRunner(
		Target{Name: "a", BaseURL: a.URL, Headers: map[string]string{"Authorization": "Bearer key-a"}},
		Target{Name: "b", BaseURL: b.URL, Headers: map[string]string{"Authorization": "Bearer key-b"}},
	)
	r.Run(context.Background(), Case{
		Name: "post", Method: http.MethodPost, Path: "/api/exchange",
		Body: json.RawMessage(`{"model":"m"}`),
	})

	if !strings.HasPrefix(seen["a"], "POST /api/exchange {\"model\":\"m\"}") {
		t.Errorf("a saw %q", seen["a"])
	}
	if !strings.HasPrefix(seen["b"], "POST /api/exchange {\"model\":\"m\"}") {
		t.Errorf("b saw %q", seen["b"])
	}
	// Per-target headers are the whole reason a reference comparison works:
	// two gateways need two different keys for the same request.
	if !strings.HasSuffix(seen["a"], "auth=Bearer key-a") || !strings.HasSuffix(seen["b"], "auth=Bearer key-b") {
		t.Errorf("per-target headers not applied:\n  a=%q\n  b=%q", seen["a"], seen["b"])
	}
}

// ── the summary ─────────────────────────────────────────────────────────────

func TestSummaryCountsAndReportsIgnoredPaths(t *testing.T) {
	same := jsonBackend(t, 200, `{"id":"x","v":1}`)
	other := jsonBackend(t, 200, `{"id":"y","v":2}`)
	r := NewRunner(Target{Name: "a", BaseURL: same.URL}, Target{Name: "b", BaseURL: other.URL})

	s := r.RunAll(context.Background(), []Case{
		{Name: "one", Method: http.MethodGet, Path: "/x"},
		{Name: "two", Method: http.MethodGet, Path: "/x"},
	})

	if s.Differ != 2 || s.Same != 0 {
		t.Errorf("same=%d differ=%d", s.Same, s.Differ)
	}
	// The ignored list is the only way to tell a clean comparison from one
	// where the interesting field was on the volatile list.
	if got := s.IgnoredPaths(); len(got) != 1 || got[0] != "id" {
		t.Errorf("IgnoredPaths = %v, want [id]", got)
	}
}

func TestAllAgreeingSaysItIsSafeToSwitch(t *testing.T) {
	body := `{"ok":true}`
	a, b := jsonBackend(t, 200, body), jsonBackend(t, 200, body)
	r := NewRunner(Target{Name: "go", BaseURL: a.URL}, Target{Name: "node", BaseURL: b.URL})
	s := r.RunAll(context.Background(), []Case{{Name: "x", Method: http.MethodGet, Path: "/x"}})

	if !strings.Contains(s.Text(), "safe to switch") {
		t.Errorf("a fully-agreeing run should say so:\n%s", s.Text())
	}
}

// The same logical endpoint does not always live at the same URL on two
// gateways. Without this the MCP comparison cannot be made at all: TokenShield
// serves /v1/mcp, LiteLLM serves /mcp.
func TestPerTargetPathOverride(t *testing.T) {
	seen := map[string]string{}
	record := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			seen[name] = r.URL.Path
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}
	}
	a := backend(t, record("a"))
	b := backend(t, record("b"))

	r := NewRunner(Target{Name: "a", BaseURL: a.URL}, Target{Name: "b", BaseURL: b.URL})
	rep := r.Run(context.Background(), Case{
		Name: "mcp", Method: http.MethodGet, Path: "/v1/mcp", BPath: "/mcp",
	})

	if seen["a"] != "/v1/mcp" || seen["b"] != "/mcp" {
		t.Errorf("paths: a=%q b=%q", seen["a"], seen["b"])
	}
	if rep.A.Path != "/v1/mcp" || rep.B.Path != "/mcp" {
		t.Errorf("paths not recorded on the sides: %q %q", rep.A.Path, rep.B.Path)
	}
}

// A differing path must be visible in the report, or a reader cannot tell an
// apples-to-apples comparison from one that was not.
func TestDifferingPathsAreShownInTheReport(t *testing.T) {
	rep := runOne(t, jsonBackend(t, 200, `{"v":1}`), jsonBackend(t, 200, `{"v":2}`),
		Case{Name: "mcp", Method: http.MethodGet, Path: "/v1/mcp", BPath: "/mcp"})

	text := Summary{Reports: []CaseReport{rep}}.Text()
	if !strings.Contains(text, "path:   a=/v1/mcp b=/mcp") {
		t.Errorf("the report does not show the differing paths:\n%s", text)
	}
}

// Removing a header, not blanking it: "no Authorization at all" and
// "Authorization: " are different requests, and only the first is the case a
// client SDK actually produces when it forgets to authenticate.
func TestEmptyCaseHeaderRemovesTheTargetHeader(t *testing.T) {
	var got string
	var present bool
	srv := backend(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		_, present = r.Header["Authorization"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})

	r := NewRunner(
		Target{Name: "a", BaseURL: srv.URL, Headers: map[string]string{"Authorization": "Bearer real"}},
		Target{Name: "b", BaseURL: srv.URL},
	)
	r.Run(context.Background(), Case{
		Name: "no-auth", Method: http.MethodGet, Path: "/x",
		Headers: map[string]string{"Authorization": ""},
	})

	if present || got != "" {
		t.Errorf("Authorization should be absent, got present=%v %q", present, got)
	}
}

func TestBodyTextSendsInvalidJSONVerbatim(t *testing.T) {
	var got string
	var ctype string
	srv := backend(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		ctype = r.Header.Get("Content-Type")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})

	r := NewRunner(Target{Name: "a", BaseURL: srv.URL}, Target{Name: "b", BaseURL: srv.URL})
	r.Run(context.Background(), Case{
		Name: "malformed", Method: http.MethodPost, Path: "/x",
		BodyText: `{"model": `,
	})

	if got != `{"model": ` {
		t.Errorf("body sent = %q", got)
	}
	if ctype != "application/json" {
		t.Errorf("content-type = %q — a malformed body must still claim JSON, or the gateway rejects on the wrong grounds", ctype)
	}
}

// A case marked not-comparable must be visibly absent from the comparison, not
// quietly counted as agreement.
func TestSkippedCaseIsNeitherSameNorDiffer(t *testing.T) {
	a := jsonBackend(t, 200, `{"v":1}`)
	b := jsonBackend(t, 500, `{"v":2}`)
	r := NewRunner(Target{Name: "a", BaseURL: a.URL}, Target{Name: "b", BaseURL: b.URL})

	s := r.RunAll(context.Background(), []Case{
		{Name: "real", Method: http.MethodGet, Path: "/x"},
		{Name: "artefact", Method: http.MethodGet, Path: "/x", Skip: "litellm has no database here"},
	})

	if s.Same != 0 || s.Differ != 1 || s.Skipped != 1 {
		t.Errorf("same=%d differ=%d skipped=%d", s.Same, s.Differ, s.Skipped)
	}
	text := s.Text()
	if !strings.Contains(text, "skip    artefact") || !strings.Contains(text, "no database here") {
		t.Errorf("the skip and its reason are not both shown:\n%s", text)
	}
	if !strings.Contains(text, "1 not comparable") {
		t.Errorf("the total does not say what was not compared:\n%s", text)
	}
}
