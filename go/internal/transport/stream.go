// Package transport makes the HTTP calls, and is the only place that does.
//
// One place, so that every exchange is recorded the same way and a credential
// cannot leak from a path nobody thought about.
//
// # The four fixes this port must not lose
//
// The TypeScript streaming path carries four corrections, each of which was a
// live bug found by running the thing. A Go rewrite is a chance to reintroduce
// all four, so each is named here next to the code that prevents it.
//
//  1. **Abort on the right signal.** In Node the bug was listening for `close`
//     on the *request*: Node 16+ fires that as soon as the request body is
//     consumed, so every stream aborted itself about 1.5 ms in. Go's analogue
//     is `Request.Context()`, which is cancelled when the *client* disconnects
//     and not when the body is read — the correct signal. The trap is
//     different in shape but identical in consequence, so it is tested.
//  2. **Switch on the RESPONSE content-type, not the request's intent.** A
//     gateway can answer a `stream: true` request with plain JSON — an error,
//     usually. Deciding "this is a stream" from what was asked for discards
//     that answer entirely.
//  3. **Keep captured headers on the abort path.** Headers arrive before the
//     body, so an aborted stream still has an `X-Request-ID`. That id is the
//     only handle for "did the stream I cancelled still get billed?", and
//     losing it on abort throws away the answer.
//  4. **Round after subtracting.** Rounding two timestamps and then
//     subtracting produces noise like `162.95000000000005`. Subtract, then
//     round.
package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/cloudgov/tokenshield-lab/internal/sse"
)

// Round2 rounds to two decimal places.
//
// Fix 4. Always applied AFTER a subtraction, never to the operands: rounding
// each timestamp first and subtracting reintroduces exactly the floating-point
// noise this exists to remove.
func Round2(v float64) float64 {
	// math.Floor(x+0.5), not int64 truncation. Both agree on every positive
	// value — including 2.675, where the float64 representation decides the
	// answer — but truncation rounds negatives toward zero while JavaScript's
	// Math.round goes toward +Infinity, so -1.005 would give -0.99 here and -1
	// there. Elapsed times are never negative, so this never fires today; a
	// known divergence in the one function whose job is matching the oracle is
	// still not worth keeping.
	return math.Floor(v*100+0.5) / 100
}

// StreamRequest is one streaming call.
type StreamRequest struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    []byte
	// Timeout bounds the WHOLE stream, not one read. A brokered MCP
	// conversation was measured at nine seconds, so this is generous by design.
	Timeout time.Duration
}

// StreamResult is everything observed, including on the failure paths.
type StreamResult struct {
	Status int
	// Headers captured as soon as they arrived. Populated even when the stream
	// was aborted — fix 3.
	Headers map[string]string
	Chunks  []sse.Chunk
	// Body is set when the response was NOT an event-stream — fix 2. A
	// non-stream answer to a streaming request is a finding, not an error.
	Body []byte
	// WasEventStream records what the RESPONSE said, not what was asked for.
	WasEventStream bool
	// Aborted is true when the caller or the timeout stopped it. Whatever
	// arrived before that is still in Chunks.
	Aborted bool
	// TransportError is set when no response arrived at all.
	TransportError string
	FirstByteMs    float64
	TotalMs        float64
}

// Client performs streaming calls.
type Client struct {
	HTTP *http.Client
	// Now is injectable so tests can assert timing without sleeping.
	Now func() time.Time
}

// NewClient builds a client with no overall HTTP timeout: the per-request
// timeout in StreamRequest governs, because one client is shared by calls with
// very different legitimate durations.
func NewClient() *Client {
	return &Client{
		HTTP: &http.Client{Timeout: 0},
		Now:  time.Now,
	}
}

// Stream performs the request and parses the response as SSE.
//
// ctx cancels the stream — that is fix 1's correct signal. Callers relaying to
// a browser must pass the *request* context so a client disconnect stops the
// work, and must NOT invent a signal from anything tied to reading the body.
func (c *Client) Stream(ctx context.Context, req StreamRequest) StreamResult {
	start := c.Now()
	elapsed := func() float64 {
		return Round2(float64(c.Now().Sub(start).Microseconds()) / 1000)
	}

	res := StreamResult{Headers: map[string]string{}}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = strings.NewReader(string(req.Body))
	}
	httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, bodyReader)
	if err != nil {
		res.TransportError = err.Error()
		res.TotalMs = elapsed()
		return res
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}

	httpRes, err := c.HTTP.Do(httpReq)
	if err != nil {
		res.TransportError = describeTransportError(err, req.URL)
		res.TotalMs = elapsed()
		return res
	}
	defer func() { _ = httpRes.Body.Close() }()

	// Fix 3: capture headers the moment they arrive, before any body read can
	// fail or be aborted. X-Request-ID lives here and is the only handle for
	// "did the stream I cancelled still get billed?".
	res.Status = httpRes.StatusCode
	for k := range httpRes.Header {
		res.Headers[strings.ToLower(k)] = httpRes.Header.Get(k)
	}

	// Fix 2: what the RESPONSE says, never what the request asked for.
	res.WasEventStream = strings.Contains(
		strings.ToLower(res.Headers["content-type"]), "text/event-stream")

	if !res.WasEventStream {
		// A non-stream answer to a streaming request is usually the error that
		// explains everything. Reading it is the whole point.
		body, readErr := io.ReadAll(io.LimitReader(httpRes.Body, 8<<20))
		res.Body = body
		if readErr != nil && !isCancellation(readErr) {
			res.TransportError = readErr.Error()
		}
		res.TotalMs = elapsed()
		return res
	}

	var parser sse.Parser
	buf := make([]byte, 8192)
	first := true
	for {
		n, readErr := httpRes.Body.Read(buf)
		if n > 0 {
			at := elapsed()
			if first {
				res.FirstByteMs = at
				first = false
			}
			res.Chunks = append(res.Chunks, parser.Push(buf[:n], at)...)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				res.Chunks = append(res.Chunks, parser.Flush(elapsed())...)
			} else if isCancellation(readErr) || ctx.Err() != nil {
				// Aborted. Everything already received is kept, along with the
				// headers captured above — fix 3 again, from the other side.
				res.Aborted = true
				res.Chunks = append(res.Chunks, parser.Flush(elapsed())...)
			} else {
				res.TransportError = readErr.Error()
			}
			break
		}
	}

	if ctx.Err() != nil {
		res.Aborted = true
	}
	res.TotalMs = elapsed()
	return res
}

func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

// describeTransportError unwraps to something actionable.
//
// "fetch failed" with the cause buried was a real time-waster in the
// TypeScript, so the Go version names the host and says what to check.
func describeTransportError(err error, url string) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection could be made") ||
		strings.Contains(msg, "connection refused"):
		return fmt.Sprintf("ECONNREFUSED — nothing is listening at %s", url)
	case strings.Contains(msg, "no such host"):
		return fmt.Sprintf("ENOTFOUND — %s does not resolve", url)
	case errors.Is(err, context.DeadlineExceeded):
		return fmt.Sprintf("timed out calling %s", url)
	case errors.Is(err, context.Canceled):
		return "cancelled"
	}
	return msg
}
