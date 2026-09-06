package diff

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// The harness: one request, two backends, one report.
//
// For the migration this answers "is the Go handler safe to switch on?" — an
// endpoint is migrated only when Go and Node agree on it, so the diff is the
// gate rather than a nice-to-have.
//
// The same call answers the more valuable question with different targets:
// TokenShield versus LiteLLM. Nothing here knows which it is doing.

// Target is one backend.
type Target struct {
	// Name appears in the report. "go"/"node" for a migration check,
	// "tokenshield"/"litellm" for a reference comparison.
	Name    string
	BaseURL string
	// Headers are merged into every request — an API key differing per target
	// is the normal case for a reference comparison.
	Headers map[string]string
}

// Case is one request sent to both targets.
type Case struct {
	Name   string
	Method string
	Path   string
	// APath and BPath override Path for one target. The same endpoint does not
	// always live at the same URL on two gateways — TokenShield serves MCP at
	// /v1/mcp, LiteLLM at /mcp — and a comparison that cannot reach both is
	// worth less than one that admits the paths differ.
	APath string
	BPath string
	Body  json.RawMessage
	// BodyText is sent verbatim, for a body that is not valid JSON. Malformed
	// input is a real contract surface — the parse-error envelope is the first
	// thing a client SDK sees when it gets serialisation wrong — and it cannot
	// be expressed as json.RawMessage.
	BodyText string
	// Headers for this case, merged over the target's. An EMPTY value removes
	// the target's header instead of sending a blank one, which is the only way
	// to test what a gateway does with no Authorization at all.
	Headers map[string]string
	// Volatile paths beyond the defaults, for a case with its own instability.
	Volatile []Volatile
	// Skip, when set, is the reason this case cannot be compared — a difference
	// caused by the harness's own setup rather than by either gateway. Kept in
	// the file rather than deleted so nobody re-adds it later and reports the
	// artefact as a finding.
	Skip string
}

// Side is what one target answered.
type Side struct {
	Target string `json:"target"`
	// Path is recorded because it is not always the same on both sides. A
	// reader seeing DIFFER needs to know whether the two targets were even
	// asked the same URL.
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
	Error   string            `json:"error,omitempty"`
	Ms      float64           `json:"ms"`
}

// CaseReport is one case compared.
type CaseReport struct {
	Case string `json:"case"`
	A    Side   `json:"a"`
	B    Side   `json:"b"`
	// StatusDiffers is called out separately from the body: two backends
	// agreeing on a body while disagreeing on the status is still a break, and
	// it is the kind of thing a body-only diff would miss entirely.
	StatusDiffers bool   `json:"statusDiffers"`
	Body          Report `json:"body"`
	Same          bool   `json:"same"`
	// Skipped is the reason the case was not run, if it was not.
	Skipped string `json:"skipped,omitempty"`
}

// Runner drives cases against two targets.
type Runner struct {
	A, B   Target
	Client *http.Client
	// Sequential by default. Two backends hit concurrently share whatever rate
	// limit or budget sits behind them, and a 429 caused by the harness itself
	// would read as a difference between the backends.
	Pause time.Duration
}

// NewRunner builds a runner with a timeout generous enough for a brokered MCP
// conversation, which was measured at nine seconds.
func NewRunner(a, b Target) *Runner {
	return &Runner{A: a, B: b, Client: &http.Client{Timeout: 5 * time.Minute}}
}

// Run sends one case to both targets and compares.
func (r *Runner) Run(ctx context.Context, c Case) CaseReport {
	rep := CaseReport{Case: c.Name}
	if c.Skip != "" {
		rep.Skipped = c.Skip
		return rep
	}
	rep.A = r.call(ctx, r.A, c, pathFor(c.APath, c.Path))
	if r.Pause > 0 {
		select {
		case <-time.After(r.Pause):
		case <-ctx.Done():
		}
	}
	rep.B = r.call(ctx, r.B, c, pathFor(c.BPath, c.Path))

	rep.StatusDiffers = rep.A.Status != rep.B.Status

	vol := append(append([]Volatile{}, DefaultVolatile...), c.Volatile...)
	rep.Body = Compare(rep.A.Body, rep.B.Body, Options{Volatile: vol})

	// A transport failure on either side is never "same", even when both
	// bodies are empty and would otherwise compare equal.
	transportFailed := rep.A.Error != "" || rep.B.Error != ""
	rep.Same = !rep.StatusDiffers && rep.Body.Same && !transportFailed
	return rep
}

// pathFor lets one target use a different URL for the same logical endpoint.
func pathFor(override, fallback string) string {
	if override != "" {
		return override
	}
	return fallback
}

func (r *Runner) call(ctx context.Context, t Target, c Case, path string) Side {
	side := Side{Target: t.Name, Path: path}
	start := time.Now()
	defer func() { side.Ms = float64(time.Since(start).Microseconds()) / 1000 }()

	var body io.Reader
	raw := []byte(c.BodyText)
	if len(c.Body) > 0 {
		raw = c.Body
	}
	if len(raw) > 0 {
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, c.Method, strings.TrimRight(t.BaseURL, "/")+path, body)
	if err != nil {
		side.Error = err.Error()
		return side
	}
	if len(raw) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range t.Headers {
		req.Header.Set(k, v)
	}
	for k, v := range c.Headers {
		if v == "" {
			req.Header.Del(k)
			continue
		}
		req.Header.Set(k, v)
	}

	res, err := r.Client.Do(req)
	if err != nil {
		side.Error = err.Error()
		return side
	}
	defer func() { _ = res.Body.Close() }()

	side.Status = res.StatusCode
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if readErr != nil {
		side.Error = readErr.Error()
	}
	side.Body = raw

	// Only the headers a difference would matter for. Copying all of them
	// would bury the signal under Date, Content-Length and the backend marker
	// that is different by design.
	side.Headers = map[string]string{}
	for _, h := range []string{"content-type", "x-request-id", "retry-after", "x-should-retry"} {
		if v := res.Header.Get(h); v != "" {
			side.Headers[h] = v
		}
	}
	return side
}

// Summary is a whole run.
type Summary struct {
	Reports []CaseReport `json:"reports"`
	Same    int          `json:"same"`
	Differ  int          `json:"differ"`
	Skipped int          `json:"skipped"`
}

// RunAll runs every case in order.
func (r *Runner) RunAll(ctx context.Context, cases []Case) Summary {
	s := Summary{}
	for _, c := range cases {
		rep := r.Run(ctx, c)
		s.Reports = append(s.Reports, rep)
		if rep.Skipped != "" {
			s.Skipped++
			continue
		}
		if rep.Same {
			s.Same++
		} else {
			s.Differ++
		}
		if ctx.Err() != nil {
			break
		}
	}
	return s
}

// Text renders a summary for a terminal.
func (s Summary) Text() string {
	var b strings.Builder
	for _, rep := range s.Reports {
		if rep.Skipped != "" {
			fmt.Fprintf(&b, "  skip    %s\n            %s\n", rep.Case, rep.Skipped)
			continue
		}
		if rep.Same {
			fmt.Fprintf(&b, "  same    %s\n", rep.Case)
			continue
		}
		fmt.Fprintf(&b, "  DIFFER  %s\n", rep.Case)
		if rep.A.Path != rep.B.Path {
			fmt.Fprintf(&b, "            path:   %s=%s %s=%s\n",
				rep.A.Target, rep.A.Path, rep.B.Target, rep.B.Path)
		}
		if rep.A.Error != "" {
			fmt.Fprintf(&b, "            %s: %s\n", rep.A.Target, rep.A.Error)
		}
		if rep.B.Error != "" {
			fmt.Fprintf(&b, "            %s: %s\n", rep.B.Target, rep.B.Error)
		}
		if rep.StatusDiffers {
			fmt.Fprintf(&b, "            status: %s=%d %s=%d\n",
				rep.A.Target, rep.A.Status, rep.B.Target, rep.B.Status)
		}
		for _, d := range rep.Body.Differences {
			fmt.Fprintf(&b, "            %s\n", d)
		}
		if rep.Body.Total > len(rep.Body.Differences) {
			fmt.Fprintf(&b, "            … and %d more\n", rep.Body.Total-len(rep.Body.Differences))
		}
	}
	fmt.Fprintf(&b, "\n  %d same, %d differ", s.Same, s.Differ)
	if s.Skipped > 0 {
		fmt.Fprintf(&b, ", %d not comparable", s.Skipped)
	}
	fmt.Fprintln(&b)
	if s.Differ == 0 && s.Same > 0 {
		fmt.Fprintf(&b, "  Every case agreed. For a migration that means the endpoint is safe to switch over.\n")
	}
	return b.String()
}

// IgnoredPaths lists every path hidden by volatility across the run,
// deduplicated.
//
// Worth printing: it is the only way to tell a genuinely clean comparison from
// one where the interesting field happened to be on the volatile list.
func (s Summary) IgnoredPaths() []string {
	seen := map[string]bool{}
	for _, rep := range s.Reports {
		for _, p := range rep.Body.Ignored {
			seen[p] = true
		}
	}
	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
