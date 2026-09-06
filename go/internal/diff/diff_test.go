package diff

import (
	"encoding/json"
	"strings"
	"testing"
)

func cmp(t *testing.T, a, b string, opts ...Options) Report {
	t.Helper()
	o := Options{}
	if len(opts) > 0 {
		o = opts[0]
	}
	return Compare(json.RawMessage(a), json.RawMessage(b), o)
}

func paths(r Report) []string {
	out := make([]string, 0, len(r.Differences))
	for _, d := range r.Differences {
		out = append(out, d.Path)
	}
	return out
}

// ── the point of the package: identical is identical ────────────────────────

func TestIdenticalIsSame(t *testing.T) {
	r := cmp(t, `{"a":1,"b":[1,2],"c":{"d":"x"}}`, `{"a":1,"b":[1,2],"c":{"d":"x"}}`)
	if !r.Same {
		t.Errorf("want same, got %v", r.Differences)
	}
}

func TestKeyOrderIsNotADifference(t *testing.T) {
	// JSON objects are unordered; two backends serialising in different orders
	// is not something a client can observe.
	r := cmp(t, `{"a":1,"b":2}`, `{"b":2,"a":1}`)
	if !r.Same {
		t.Errorf("key order reported as a difference: %v", r.Differences)
	}
}

// ── the kinds, which are not equally serious ────────────────────────────────

func TestATypeChangeIsNotAValueChange(t *testing.T) {
	// A number where a string was breaks a typed client at parse time, even
	// when the rendering looks similar. It must not be reported as a mere
	// value difference.
	r := cmp(t, `{"n":429}`, `{"n":"429"}`)
	if len(r.Differences) != 1 || r.Differences[0].Kind != KindType {
		t.Fatalf("want one type difference, got %+v", r.Differences)
	}
	if r.Differences[0].A != "number" || r.Differences[0].B != "string" {
		t.Errorf("types not named: %+v", r.Differences[0])
	}
}

func TestMissingOnEitherSideIsDistinguished(t *testing.T) {
	r := cmp(t, `{"only_a":1,"both":2}`, `{"both":2,"only_b":3}`)
	kinds := map[string]Kind{}
	for _, d := range r.Differences {
		kinds[d.Path] = d.Kind
	}
	if kinds["only_a"] != KindMissingInB {
		t.Errorf("only_a: %v, want missing-in-b", kinds["only_a"])
	}
	if kinds["only_b"] != KindMissingInA {
		t.Errorf("only_b: %v, want missing-in-a", kinds["only_b"])
	}
}

func TestArrayLengthIsOneDifferenceNotN(t *testing.T) {
	// Reporting one difference per index would bury everything else in the
	// response behind noise from a single missing element.
	r := cmp(t, `{"xs":[1,2,3,4,5]}`, `{"xs":[1]}`)
	if len(r.Differences) != 1 {
		t.Fatalf("want 1 difference, got %d: %v", len(r.Differences), r.Differences)
	}
	if r.Differences[0].Kind != KindLength || r.Differences[0].A != "5" || r.Differences[0].B != "1" {
		t.Errorf("want a length difference 5 vs 1, got %+v", r.Differences[0])
	}
}

func TestNestedPathsAreAddressable(t *testing.T) {
	r := cmp(t,
		`{"output":[{"mcp_call":{"name":"hub_repo_search"}}]}`,
		`{"output":[{"mcp_call":{"name":"hub_repo_details"}}]}`)
	if len(r.Differences) != 1 {
		t.Fatalf("want 1, got %v", r.Differences)
	}
	// The path is what makes a report actionable rather than "they differ".
	if got := r.Differences[0].Path; got != "output.0.mcp_call.name" {
		t.Errorf("path = %q", got)
	}
}

// ── volatility: the dangerous part ──────────────────────────────────────────

func TestVolatilePathsAreIgnoredButRecorded(t *testing.T) {
	r := cmp(t,
		`{"id":"resp_aaa","totalMs":12.5,"answer":"hello"}`,
		`{"id":"resp_bbb","totalMs":99.1,"answer":"hello"}`)
	if !r.Same {
		t.Errorf("timings and ids should not count as differences: %v", r.Differences)
	}
	// Recorded, not silently dropped — otherwise there is no way to tell a
	// clean comparison from one where everything interesting was hidden.
	if len(r.Ignored) != 2 {
		t.Errorf("ignored = %v, want id and totalMs", r.Ignored)
	}
}

func TestARealDifferenceBesideAVolatileOneStillReports(t *testing.T) {
	r := cmp(t,
		`{"id":"a","status":"completed"}`,
		`{"id":"b","status":"failed"}`)
	if r.Same {
		t.Fatal("a real difference was hidden by a volatile one alongside it")
	}
	if paths(r)[0] != "status" {
		t.Errorf("paths = %v, want status", paths(r))
	}
}

func TestVolatilityCanBeTurnedOffEntirely(t *testing.T) {
	// The setting for when you suspect a difference is being hidden.
	r := cmp(t, `{"id":"a"}`, `{"id":"b"}`, Options{Volatile: []Volatile{}})
	if r.Same {
		t.Error("with volatility off, an id difference must report")
	}
}

func TestNestedIdsAreVolatileAtAnyDepth(t *testing.T) {
	// Ids appear at every depth; listing each path would be a maintenance trap.
	r := cmp(t,
		`{"output":[{"id":"mcp_1","name":"x"}]}`,
		`{"output":[{"id":"mcp_9","name":"x"}]}`)
	if !r.Same {
		t.Errorf("a nested id should be volatile: %v", r.Differences)
	}
}

func TestEveryVolatileEntryStatesWhy(t *testing.T) {
	// An entry with no reason is indistinguishable from someone silencing a
	// failure they did not understand.
	for _, v := range DefaultVolatile {
		if strings.TrimSpace(v.Why) == "" {
			t.Errorf("volatile %q has no reason recorded", v.Pattern)
		}
		if v.Pattern == "*" || v.Pattern == "" {
			t.Errorf("volatile %q is too broad — it would hide everything", v.Pattern)
		}
	}
}

// ── malformed input is a finding, not a crash ───────────────────────────────

func TestUnparseableOnOneSideIsReported(t *testing.T) {
	r := cmp(t, `{"a":1}`, `<html>502 Bad Gateway</html>`)
	if r.Same {
		t.Fatal("valid JSON vs HTML must not compare as same")
	}
	if !strings.Contains(r.Differences[0].B, "not JSON") {
		t.Errorf("difference does not say what B was: %+v", r.Differences[0])
	}
}

func TestBothUnparseableTheSameWayIsSame(t *testing.T) {
	// Two backends both returning an empty body agree, and saying otherwise
	// would produce a permanent false positive.
	r := cmp(t, ``, ``)
	if !r.Same {
		t.Errorf("two empty bodies: %v", r.Differences)
	}
}

func TestNullIsNotMissing(t *testing.T) {
	// `{"a":null}` and `{}` are different to a client: one has the key.
	r := cmp(t, `{"a":null}`, `{}`)
	if r.Same {
		t.Fatal("an explicit null and an absent key are not the same")
	}
	if r.Differences[0].Kind != KindMissingInB {
		t.Errorf("kind = %v", r.Differences[0].Kind)
	}
}

// ── the cap ─────────────────────────────────────────────────────────────────

func TestTheReportIsCappedButSaysHowMuchItHid(t *testing.T) {
	var a, b strings.Builder
	a.WriteString(`{`)
	b.WriteString(`{`)
	for i := 0; i < 100; i++ {
		if i > 0 {
			a.WriteString(",")
			b.WriteString(",")
		}
		a.WriteString(`"k` + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + `":1`)
		b.WriteString(`"k` + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + `":2`)
	}
	a.WriteString(`}`)
	b.WriteString(`}`)

	r := cmp(t, a.String(), b.String(), Options{MaxDifferences: 5})
	if len(r.Differences) != 5 {
		t.Errorf("shown = %d, want 5", len(r.Differences))
	}
	// A truncated report that does not say it truncated is a lie by omission.
	if r.Total <= 5 {
		t.Errorf("Total = %d, should report the real count", r.Total)
	}
}

// ── the second use: gateway vs reference implementation ─────────────────────

func TestTheRealTokenShieldVsOpenAIShape(t *testing.T) {
	// A cut-down version of the divergences already found by hand, to show the
	// harness reports them: comma-joined server_label, and a status field
	// OpenAI's item does not have.
	tokenshield := `{"output":[{"type":"mcp_list_tools","status":"completed",
		"server_label":"HuggingFace,MS Learn","tools":[{"name":"a"}]}]}`
	openai := `{"output":[{"type":"mcp_list_tools",
		"server_label":"HuggingFace","tools":[{"name":"a","input_schema":{}}]}]}`

	r := cmp(t, tokenshield, openai)
	if r.Same {
		t.Fatal("known divergences were not reported")
	}
	got := strings.Join(paths(r), " ")
	for _, want := range []string{
		"output.0.status",                     // non-standard field
		"output.0.server_label",               // comma-joined
		"output.0.tools.0.input_schema",       // missing, and OpenAI requires it
	} {
		if !strings.Contains(got, want) {
			t.Errorf("did not report %s — paths were %v", want, paths(r))
		}
	}
}
