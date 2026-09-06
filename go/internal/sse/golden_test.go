package sse

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The TypeScript parser is the oracle. Same fixtures, same expected frames.
// Regenerate with `node scripts/gen-golden.mjs`.

type sseCase struct {
	Name   string   `json:"name"`
	Pushes []string `json:"pushes"`
}

type sseGolden struct {
	Name   string  `json:"name"`
	Frames []Chunk `json:"frames"`
}

func load[T any](t *testing.T, path string) []T {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — regenerate with `node scripts/gen-golden.mjs`", path, err)
	}
	var out []T
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(out) == 0 {
		t.Fatalf("%s is empty — an empty golden passes everything, which is worse than failing", path)
	}
	return out
}

func TestParserMatchesTheTypeScriptOracle(t *testing.T) {
	cases := load[sseCase](t, filepath.Join("..", "..", "..", "testdata", "sse-cases.json"))
	golden := load[sseGolden](t, filepath.Join("..", "contract", "testdata", "sse-golden.json"))

	if len(cases) != len(golden) {
		t.Fatalf("%d inputs but %d golden results — the golden file is stale", len(cases), len(golden))
	}

	for i, c := range cases {
		want := golden[i]
		if c.Name != want.Name {
			t.Fatalf("case %d: input %q vs golden %q — the files are out of order", i, c.Name, want.Name)
		}

		t.Run(c.Name, func(t *testing.T) {
			var p Parser
			var got []Chunk
			tt := 0.0
			for _, push := range c.Pushes {
				tt += 10
				got = append(got, p.PushText(push, tt)...)
			}
			got = append(got, p.Flush(tt+10)...)

			if len(got) != len(want.Frames) {
				t.Fatalf("%d frames, TypeScript produced %d\n  got:  %+v\n  want: %+v",
					len(got), len(want.Frames), got, want.Frames)
			}
			for j := range got {
				g, w := got[j], want.Frames[j]
				if g.Seq != w.Seq || g.T != w.T || g.Raw != w.Raw {
					t.Errorf("frame %d: seq/t/raw = %d/%v/%q, TypeScript says %d/%v/%q",
						j, g.Seq, g.T, g.Raw, w.Seq, w.T, w.Raw)
				}
				if g.Event != w.Event {
					t.Errorf("frame %d: event = %q, TypeScript says %q", j, g.Event, w.Event)
				}
				// Presence matters as much as content: `parsed` absent is how a
				// malformed frame is reported, so a port that parses it anyway
				// hides the finding.
				if (len(g.Parsed) == 0) != (len(w.Parsed) == 0) {
					t.Errorf("frame %d: parsed present = %v, TypeScript says %v (raw %q)",
						j, len(g.Parsed) > 0, len(w.Parsed) > 0, g.Raw)
				}
				if len(g.Parsed) > 0 && len(w.Parsed) > 0 && !jsonEqual(g.Parsed, w.Parsed) {
					t.Errorf("frame %d: parsed = %s, TypeScript says %s", j, g.Parsed, w.Parsed)
				}
				if g.Done != w.Done || g.Incomplete != w.Incomplete || g.Comment != w.Comment {
					t.Errorf("frame %d: done/incomplete/comment = %v/%v/%v, TypeScript says %v/%v/%v",
						j, g.Done, g.Incomplete, g.Comment, w.Done, w.Incomplete, w.Comment)
				}
			}
		})
	}
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ax, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	return string(ax) == string(by)
}

// ── the byte-level case the JSON fixtures cannot express ────────────────────

func TestMultiByteRuneSplitAcrossReads(t *testing.T) {
	// "日本" is 6 bytes. Splitting mid-character is exactly what a network read
	// does, and decoding each read independently corrupts it — the bug this
	// parser was written to avoid.
	full := []byte("data: {\"t\":\"日本\"}\n\n")
	for cut := 1; cut < len(full); cut++ {
		var p Parser
		frames := p.Push(full[:cut], 1)
		frames = append(frames, p.Push(full[cut:], 2)...)
		frames = append(frames, p.Flush(3)...)

		if len(frames) != 1 {
			t.Fatalf("cut at %d: %d frames, want 1", cut, len(frames))
		}
		if !strings.Contains(frames[0].Raw, "日本") {
			t.Errorf("cut at %d: text corrupted — raw = %q", cut, frames[0].Raw)
		}
		if len(frames[0].Parsed) == 0 {
			t.Errorf("cut at %d: valid JSON was not parsed — raw = %q", cut, frames[0].Raw)
		}
	}
}

func TestBytesAndTextAgree(t *testing.T) {
	const s = "event: x\ndata: {\"a\":1}\n\n"
	var byBytes, byText Parser
	a := byBytes.Push([]byte(s), 5)
	b := byText.PushText(s, 5)
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("frames: bytes=%d text=%d", len(a), len(b))
	}
	if a[0].Raw != b[0].Raw || a[0].Event != b[0].Event {
		t.Errorf("Push and PushText disagree: %+v vs %+v", a[0], b[0])
	}
}

// A stream that ends mid-rune is damage, and the bytes must not vanish.
func TestFlushEmitsAnUnterminatedRune(t *testing.T) {
	var p Parser
	partial := []byte("data: ")
	partial = append(partial, []byte("日")[:2]...) // deliberately cut
	p.Push(partial, 1)
	frames := p.Flush(2)
	if len(frames) != 1 {
		t.Fatalf("%d frames, want 1 incomplete frame", len(frames))
	}
	if !frames[0].Incomplete {
		t.Error("a stream cut mid-frame must be flagged incomplete")
	}
}
