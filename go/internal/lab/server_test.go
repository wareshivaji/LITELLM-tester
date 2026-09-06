package lab

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newServer(t *testing.T, upstream string) *Server {
	t.Helper()
	s, err := New(Options{
		Addr:     "127.0.0.1:0",
		Upstream: upstream,
		Version:  "test",
		Started:  time.Now().Add(-30 * time.Second),
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func get(t *testing.T, s *Server, path string) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Result()
}

func decode(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

// A stand-in for the Node backend, so the seam can be tested without running it.
func fakeNode(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"service":"tokenshield-lab-server","status":"healthy","history":{"size":7}}`))
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"profiles":[{"id":"local"}],"keys":[]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// ── the proxy: everything unmigrated still reaches Node, unchanged ──────────

func TestUnmigratedEndpointIsProxiedUnchanged(t *testing.T) {
	node := fakeNode(t)
	res := get(t, newServer(t, node.URL), "/api/config")

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if got := res.Header.Get(BackendHeader); got != "node" {
		t.Errorf("%s = %q, want node — a proxied response must not claim Go answered it", BackendHeader, got)
	}
	body := decode(t, res)
	profiles, ok := body["profiles"].([]any)
	if !ok || len(profiles) != 1 {
		t.Fatalf("proxied body was altered: %v", body)
	}
}

// ── the merge: Node's numbers survive, Go's are added ───────────────────────

func TestHealthMergesBothBackends(t *testing.T) {
	node := fakeNode(t)
	res := get(t, newServer(t, node.URL), "/api/health")
	body := decode(t, res)

	// Node still owns the exchange history and the session registry, so
	// dropping its fields would make the console wrong.
	if body["service"] != "tokenshield-lab-server" {
		t.Errorf("service = %v, want Node's value preserved", body["service"])
	}
	history, ok := body["history"].(map[string]any)
	if !ok || history["size"] != float64(7) {
		t.Errorf("Node's history was lost in the merge: %v", body["history"])
	}

	backends, ok := body["backends"].(map[string]any)
	if !ok {
		t.Fatal("no backends block was added")
	}
	goBlk, _ := backends["go"].(map[string]any)
	if goBlk["status"] != "healthy" || goBlk["version"] != "test" {
		t.Errorf("go block wrong: %v", goBlk)
	}
	if uptime, _ := goBlk["uptimeSeconds"].(float64); uptime < 25 {
		t.Errorf("uptimeSeconds = %v, want ~30", uptime)
	}
	nodeBlk, _ := backends["node"].(map[string]any)
	if nodeBlk["status"] != "healthy" {
		t.Errorf("node block wrong: %v", nodeBlk)
	}

	if got := res.Header.Get(BackendHeader); got != "go+node" {
		t.Errorf("%s = %q, want go+node — both contributed", BackendHeader, got)
	}
}

// ── Node down: the front door must degrade, not fail ────────────────────────

func TestHealthDegradesWhenNodeIsDown(t *testing.T) {
	// Nothing is listening here.
	res := get(t, newServer(t, "http://127.0.0.1:1"), "/api/health")

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d — a health endpoint that cannot report ill health is useless", res.StatusCode)
	}
	body := decode(t, res)
	if body["status"] != "degraded" {
		t.Errorf("status = %v, want degraded", body["status"])
	}
	backends, _ := body["backends"].(map[string]any)
	nodeBlk, _ := backends["node"].(map[string]any)
	if nodeBlk["status"] != "unreachable" {
		t.Errorf("node status = %v, want unreachable", nodeBlk["status"])
	}
	// The Go half is still fine and must say so, or this reads as total failure.
	goBlk, _ := backends["go"].(map[string]any)
	if goBlk["status"] != "healthy" {
		t.Errorf("go status = %v, want healthy", goBlk["status"])
	}
	if got := res.Header.Get(BackendHeader); got != "go" {
		t.Errorf("%s = %q, want go — Node contributed nothing", BackendHeader, got)
	}
}

func TestProxyErrorSaysHowToFixIt(t *testing.T) {
	res := get(t, newServer(t, "http://127.0.0.1:1"), "/api/config")

	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", res.StatusCode)
	}
	if got := res.Header.Get(BackendHeader); got != "go" {
		t.Errorf("%s = %q, want go", BackendHeader, got)
	}
	msg, _ := decode(t, res)["error"].(string)
	// A bare 502 during a migration is the least useful possible answer.
	if !strings.Contains(msg, "npm run dev:server") {
		t.Errorf("error does not say how to fix it: %q", msg)
	}
	if !strings.Contains(msg, "not yet migrated") {
		t.Errorf("error does not explain what Node is for: %q", msg)
	}
}

// ── /api/backends answers when Node does not ────────────────────────────────

func TestBackendsWorksWithoutNode(t *testing.T) {
	res := get(t, newServer(t, "http://127.0.0.1:1"), "/api/backends")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d — this endpoint exists precisely for when Node is down", res.StatusCode)
	}
	body := decode(t, res)
	if body["front"] != "go" {
		t.Errorf("front = %v", body["front"])
	}
	nodeBlk, _ := body["node"].(map[string]any)
	if nodeBlk["status"] != "unreachable" {
		t.Errorf("node status = %v, want unreachable", nodeBlk["status"])
	}
	if reason, _ := nodeBlk["reason"].(string); !strings.Contains(reason, "dev:server") {
		t.Errorf("reason does not say how to fix it: %q", reason)
	}
	migrated, ok := body["migrated"].([]any)
	if !ok || len(migrated) != 2 {
		t.Errorf("migrated list wrong: %v", body["migrated"])
	}
}

// ── configuration errors are refused at startup, not at request time ────────

func TestNewRefusesABadUpstream(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct{ name, upstream string }{
		{"no host", "/just/a/path"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(Options{Upstream: tc.upstream, Log: log}); err == nil {
				t.Error("want an error at construction, not a confusing 502 on every request later")
			}
		})
	}
}

func TestNewRequiresALogger(t *testing.T) {
	if _, err := New(Options{Upstream: "http://127.0.0.1:8789"}); err == nil {
		t.Error("want an error rather than a nil-pointer panic on the first proxy failure")
	}
}

// SSE must not be buffered — /api/stream exists to measure when each frame
// lands, so a buffering proxy would silently destroy every timing result.
func TestProxyDoesNotBufferStreams(t *testing.T) {
	s := newServer(t, "http://127.0.0.1:8789")
	if s.proxy.FlushInterval != -1 {
		t.Errorf("FlushInterval = %v, want -1 (immediate flush)", s.proxy.FlushInterval)
	}
}
