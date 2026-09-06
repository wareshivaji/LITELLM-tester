// Package diff compares two JSON responses and reports what a client would
// notice.
//
// # Why this is not deep-equal
//
// Two runs of the same request are never byte-identical. Exchange ids are
// UUIDs, timings differ by milliseconds, `startedAt` moves. A naive comparison
// reports every run as different, which is the same as reporting nothing.
//
// So volatile paths are **declared**, with a reason attached to each. That list
// is a contract in its own right and the most dangerous thing in this package:
// every entry is a difference deliberately hidden, and one careless wildcard
// hides the defect you were looking for. Nothing goes in it without a reason
// that says why the value cannot be stable.
//
// # Two uses, one mechanism
//
// Built for the Go migration — send a request to the Go handler and to the Node
// one, diff, and only migrate the endpoint when they agree. But comparing two
// backends is comparing two backends, so the same code answers the more
// valuable question: send the identical request to TokenShield and to LiteLLM
// and see where a gateway and its reference implementation disagree.
//
// The second use is why `A` and `B` are named rather than `go` and `node`.
package diff

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Kind is how two values differ, because the kinds are not equally serious.
type Kind string

const (
	// KindValue — same shape, different content. Often benign.
	KindValue Kind = "value"
	// KindType — number where a string was, array where an object was. Breaks a
	// typed client at parse time, so it is worse than a value difference even
	// when the values look similar.
	KindType Kind = "type"
	// KindMissingInB — present in A, absent in B.
	KindMissingInB Kind = "missing-in-b"
	// KindMissingInA — the reverse.
	KindMissingInA Kind = "missing-in-a"
	// KindLength — arrays of different length. Reported once rather than as
	// one difference per element, which would bury everything else.
	KindLength Kind = "length"
)

// Difference is one place the two responses disagree.
type Difference struct {
	// Path in dotted form: `output.0.mcp_call.name`.
	Path string `json:"path"`
	Kind Kind   `json:"kind"`
	A    string `json:"a"`
	B    string `json:"b"`
}

func (d Difference) String() string {
	switch d.Kind {
	case KindMissingInB:
		return fmt.Sprintf("%s: only in A (%s)", d.Path, d.A)
	case KindMissingInA:
		return fmt.Sprintf("%s: only in B (%s)", d.Path, d.B)
	case KindLength:
		return fmt.Sprintf("%s: %s items vs %s", d.Path, d.A, d.B)
	case KindType:
		return fmt.Sprintf("%s: TYPE differs — A %s, B %s", d.Path, d.A, d.B)
	}
	return fmt.Sprintf("%s: A %s, B %s", d.Path, d.A, d.B)
}

// Volatile is one path that legitimately differs between runs.
type Volatile struct {
	// Pattern is a dotted path where `*` matches one segment, including an
	// array index. Not a regex: a regex here would be too easy to write too
	// broadly, and every entry hides a real difference.
	Pattern string
	// Why the value cannot be stable. Required — an entry without one is
	// indistinguishable from someone silencing a failure they did not
	// understand.
	Why string
}

// DefaultVolatile is what differs between two runs of the same request through
// two backends, and is not a defect.
//
// Kept deliberately short. Anything not obviously unstable belongs in a
// difference report where a person can look at it.
var DefaultVolatile = []Volatile{
	{"*.id", "exchange and response ids are fresh per call"},
	{"id", "top-level response id"},
	{"*.exchangeId", "the lab's own per-exchange UUID"},
	{"exchangeIds.*", "same, in the preflight response"},
	{"*.totalMs", "wall-clock timing"},
	{"*.firstChunkMs", "wall-clock timing"},
	{"*.firstTextMs", "wall-clock timing"},
	{"*.lastChunkMs", "wall-clock timing"},
	{"*.maxGapMs", "wall-clock timing"},
	{"*.meanGapMs", "wall-clock timing"},
	{"totalMs", "wall-clock timing"},
	{"durationMs", "wall-clock timing"},
	{"uptimeSeconds", "how long the process has been up"},
	{"startedAt", "a timestamp"},
	{"created", "a provider timestamp"},
	{"created_at", "a provider timestamp"},
	{"*.t", "frame arrival time in ms"},
	{"*.at", "a timestamp"},
}

// Options controls a comparison.
type Options struct {
	// Volatile paths to ignore. Nil means DefaultVolatile; an explicitly empty
	// slice means ignore nothing, which is the right setting when hunting a
	// difference you suspect is being hidden.
	Volatile []Volatile
	// MaxDifferences caps the report. A response that differs everywhere
	// produces a wall of text nobody reads; the count is still reported.
	MaxDifferences int
}

// Report is the outcome of one comparison.
type Report struct {
	Same        bool         `json:"same"`
	Differences []Difference `json:"differences"`
	// Total before the cap, so a truncated report still says how much it hid.
	Total   int      `json:"total"`
	Ignored []string `json:"ignored,omitempty"`
}

// Compare diffs two JSON documents.
func Compare(a, b json.RawMessage, opts Options) Report {
	vol := opts.Volatile
	if vol == nil {
		vol = DefaultVolatile
	}
	maxDiff := opts.MaxDifferences
	if maxDiff <= 0 {
		maxDiff = 50
	}

	var av, bv any
	aErr := json.Unmarshal(a, &av)
	bErr := json.Unmarshal(b, &bv)

	// Unparseable is itself the finding, and must not be reported as "same"
	// just because both sides failed.
	if aErr != nil || bErr != nil {
		d := Difference{Path: "", Kind: KindType}
		d.A = describeParse(a, aErr)
		d.B = describeParse(b, bErr)
		if d.A == d.B {
			return Report{Same: true}
		}
		return Report{Same: false, Differences: []Difference{d}, Total: 1}
	}

	c := &collector{vol: vol}
	c.walk("", av, bv)

	sort.Slice(c.diffs, func(i, j int) bool { return c.diffs[i].Path < c.diffs[j].Path })
	total := len(c.diffs)
	shown := c.diffs
	if total > maxDiff {
		shown = shown[:maxDiff]
	}
	return Report{
		Same:        total == 0,
		Differences: shown,
		Total:       total,
		Ignored:     c.ignored,
	}
}

func describeParse(raw json.RawMessage, err error) string {
	if err == nil {
		return "valid JSON"
	}
	if len(raw) == 0 {
		return "empty"
	}
	return "not JSON: " + err.Error()
}

type collector struct {
	diffs   []Difference
	ignored []string
	vol     []Volatile
}

func (c *collector) isVolatile(path string) bool {
	for _, v := range c.vol {
		if matchPath(v.Pattern, path) {
			return true
		}
	}
	return false
}

// matchPath matches a dotted pattern where `*` covers exactly one segment.
//
// A leading `*.` also matches the bare key at the root, so `*.id` covers both
// `id` and `output.0.id` — ids appear at every depth and listing each would be
// a maintenance trap.
func matchPath(pattern, path string) bool {
	if segmentsMatch(strings.Split(pattern, "."), strings.Split(path, ".")) {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		// `*.id` should also catch a nested `a.b.id`, so try matching the
		// remainder against every suffix of the path.
		rest := pattern[2:]
		segs := strings.Split(path, ".")
		for i := range segs {
			if segmentsMatch(strings.Split(rest, "."), segs[i:]) {
				return true
			}
		}
	}
	return false
}

func segmentsMatch(pat, path []string) bool {
	if len(pat) != len(path) {
		return false
	}
	for i := range pat {
		if pat[i] != "*" && pat[i] != path[i] {
			return false
		}
	}
	return true
}

func join(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}

func (c *collector) add(d Difference) {
	if c.isVolatile(d.Path) {
		c.ignored = append(c.ignored, d.Path)
		return
	}
	c.diffs = append(c.diffs, d)
}

func (c *collector) walk(path string, a, b any) {
	ta, tb := typeName(a), typeName(b)
	if ta != tb {
		c.add(Difference{Path: path, Kind: KindType, A: ta, B: tb})
		return
	}

	switch av := a.(type) {
	case map[string]any:
		bv := b.(map[string]any)
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)

		for _, k := range sorted {
			p := join(path, k)
			x, okA := av[k]
			y, okB := bv[k]
			switch {
			case okA && !okB:
				c.add(Difference{Path: p, Kind: KindMissingInB, A: render(x)})
			case !okA && okB:
				c.add(Difference{Path: p, Kind: KindMissingInA, B: render(y)})
			default:
				c.walk(p, x, y)
			}
		}

	case []any:
		bv := b.([]any)
		if len(av) != len(bv) {
			// One length difference, not one per element. Reporting every
			// index would bury whatever else is wrong.
			c.add(Difference{
				Path: path, Kind: KindLength,
				A: strconv.Itoa(len(av)), B: strconv.Itoa(len(bv)),
			})
			return
		}
		for i := range av {
			c.walk(join(path, strconv.Itoa(i)), av[i], bv[i])
		}

	default:
		if render(a) != render(b) {
			c.add(Difference{Path: path, Kind: KindValue, A: render(a), B: render(b)})
		}
	}
}

func typeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

func render(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	s := string(b)
	if len(s) > 120 {
		return s[:117] + "..."
	}
	return s
}
