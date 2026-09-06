package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// One test per hard-won fix, named after the bug it prevents. A Go rewrite is
// exactly when these come back, and a test that only says "streaming works"
// would not notice.

func sseServer(t *testing.T, write func(w http.ResponseWriter, f http.Flusher, r *http.Request)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("test server cannot flush")
		}
		write(w, f, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ── fix 1: abort on the right signal ────────────────────────────────────────
// In Node the bug was listening for `close` on the REQUEST, which fires as soon
// as the body is consumed — every stream aborted itself ~1.5 ms in. Go's
// analogue is the request context, cancelled on client disconnect and NOT on
// body read. This asserts a stream survives having had its body sent.

func TestAStreamWithARequestBodySurvives(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, f http.Flusher, r *http.Request) {
		// Consume the body first — the exact act that killed the Node version.
		_, _ = io_ReadAll(r)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for i := 1; i <= 3; i++ {
			fmt.Fprintf(w, "data: {\"n\":%d}\n\n", i)
			f.Flush()
			time.Sleep(5 * time.Millisecond)
		}
	})

	res := NewClient().Stream(context.Background(), StreamRequest{
		Method: http.MethodPost, URL: srv.URL,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    []byte(`{"stream":true}`),
	})

	if res.Aborted {
		t.Fatal("the stream aborted itself — fix 1 has regressed")
	}
	if len(res.Chunks) != 3 {
		t.Fatalf("%d frames, want 3 — a self-abort truncates silently", len(res.Chunks))
	}
}

// ── fix 2: switch on the RESPONSE content-type ──────────────────────────────

func TestANonStreamAnswerToAStreamingRequestIsKept(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, _ http.Flusher, _ *http.Request) {
		// A gateway answering a stream:true request with a plain JSON error.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"stop must be an array"}}`))
	})

	res := NewClient().Stream(context.Background(), StreamRequest{
		Method: http.MethodPost, URL: srv.URL, Body: []byte(`{"stream":true}`),
	})

	if res.WasEventStream {
		t.Error("content-type was application/json; treating it as a stream discards the answer")
	}
	if res.Status != 400 {
		t.Errorf("status = %d, want 400", res.Status)
	}
	if !strings.Contains(string(res.Body), "stop must be an array") {
		t.Errorf("the error body was discarded: %q", res.Body)
	}
	if len(res.Chunks) != 0 {
		t.Errorf("%d frames parsed from a non-stream response", len(res.Chunks))
	}
}

// ── fix 3: captured headers survive an abort ────────────────────────────────

func TestAbortKeepsTheHeadersAndWhatArrived(t *testing.T) {
	release := make(chan struct{})
	srv := sseServer(t, func(w http.ResponseWriter, f http.Flusher, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-Id", "req-abc-123")
		w.WriteHeader(200)
		fmt.Fprint(w, "data: {\"n\":1}\n\n")
		f.Flush()
		<-release // hang until the test cancels
	})
	defer close(release)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(80 * time.Millisecond)
		cancel()
	}()

	res := NewClient().Stream(ctx, StreamRequest{Method: http.MethodGet, URL: srv.URL})

	if !res.Aborted {
		t.Error("want Aborted")
	}
	// The whole point: X-Request-ID is the only handle for "did the stream I
	// cancelled still get billed?".
	if res.Headers["x-request-id"] != "req-abc-123" {
		t.Errorf("X-Request-ID lost on abort: %v", res.Headers)
	}
	if len(res.Chunks) == 0 {
		t.Error("frames received before the abort were discarded")
	}
	if res.Status != 200 {
		t.Errorf("status lost on abort: %d", res.Status)
	}
}

func TestTimeoutIsAnAbortNotAnError(t *testing.T) {
	release := make(chan struct{})
	srv := sseServer(t, func(w http.ResponseWriter, f http.Flusher, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-Id", "req-timeout")
		w.WriteHeader(200)
		fmt.Fprint(w, "data: {\"n\":1}\n\n")
		f.Flush()
		<-release
	})
	defer close(release)

	res := NewClient().Stream(context.Background(), StreamRequest{
		Method: http.MethodGet, URL: srv.URL, Timeout: 100 * time.Millisecond,
	})

	if !res.Aborted {
		t.Error("a timeout mid-stream is an abort, not a transport error")
	}
	if res.TransportError != "" {
		t.Errorf("TransportError = %q; the response DID arrive", res.TransportError)
	}
	if res.Headers["x-request-id"] != "req-timeout" {
		t.Error("headers lost on timeout")
	}
}

// ── fix 4: round after subtracting ──────────────────────────────────────────

func TestRound2SubtractsThenRounds(t *testing.T) {
	// The exact shape of the bug: rounding operands first reintroduces noise.
	a, b := 1162.9500000000003, 1000.0
	if got := Round2(a - b); got != 162.95 {
		t.Errorf("Round2(a-b) = %v, want 162.95", got)
	}
	for _, tc := range []struct {
		in   float64
		want float64
	}{
		// Every expectation below was taken from running the TypeScript, not
		// from reasoning about IEEE754. 1.005 gives 1 and not 1.01 because
		// 1.005*100 is 100.49999999999999 in float64 — the first draft of this
		// test asserted 1.01 and was simply wrong.
		{0, 0}, {1.004, 1.0}, {1.005, 1.0}, {1.006, 1.01}, {1.015, 1.01},
		{2.675, 2.68}, {162.95000000000005, 162.95},
		// Negative: truncation would give -0.99, JavaScript gives -1.
		{-1.005, -1.0},
	} {
		if got := Round2(tc.in); got != tc.want {
			t.Errorf("Round2(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestTimingsAreRounded(t *testing.T) {
	srv := sseServer(t, func(w http.ResponseWriter, f http.Flusher, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprint(w, "data: {}\n\n")
		f.Flush()
	})
	res := NewClient().Stream(context.Background(), StreamRequest{Method: http.MethodGet, URL: srv.URL})
	if res.TotalMs != Round2(res.TotalMs) {
		t.Errorf("TotalMs = %v is not rounded", res.TotalMs)
	}
	if res.FirstByteMs != Round2(res.FirstByteMs) {
		t.Errorf("FirstByteMs = %v is not rounded", res.FirstByteMs)
	}
	if res.FirstByteMs > res.TotalMs {
		t.Errorf("first byte %v after total %v", res.FirstByteMs, res.TotalMs)
	}
}

// ── transport errors say what to do ─────────────────────────────────────────

func TestConnectionRefusedNamesTheHost(t *testing.T) {
	res := NewClient().Stream(context.Background(), StreamRequest{
		Method: http.MethodGet, URL: "http://127.0.0.1:1/api",
	})
	if res.TransportError == "" {
		t.Fatal("want a transport error")
	}
	// "fetch failed" with the cause buried wasted real time in the TypeScript.
	if !strings.Contains(res.TransportError, "ECONNREFUSED") ||
		!strings.Contains(res.TransportError, "127.0.0.1:1") {
		t.Errorf("unhelpful error: %q", res.TransportError)
	}
	if res.Status != 0 {
		t.Errorf("status = %d, want 0 — no response arrived", res.Status)
	}
}

func TestUnresolvableHostIsNamed(t *testing.T) {
	res := NewClient().Stream(context.Background(), StreamRequest{
		Method: http.MethodGet, URL: "http://no-such-host.invalid/api",
	})
	if !strings.Contains(res.TransportError, "ENOTFOUND") {
		t.Errorf("error = %q, want ENOTFOUND", res.TransportError)
	}
}

func io_ReadAll(r *http.Request) ([]byte, error) {
	defer func() { _ = r.Body.Close() }()
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for {
		n, err := r.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			return buf, nil
		}
	}
}
