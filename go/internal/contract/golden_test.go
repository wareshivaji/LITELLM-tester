package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The TypeScript implementation is the oracle.
//
// It has 340 passing tests and has been verified against a live gateway, so the
// Go port is not trusted because it reads correctly — it is trusted because it
// gives identical answers to identical inputs. A port that compiles and
// disagrees is worse than no port, because it looks finished.
//
// Regenerate with `node scripts/gen-golden.mjs`. Inputs live in ../../testdata
// and are hand-written to cover the contract: a random corpus would exercise
// the boring branches and miss the two 429s and the guardrail-is-400, which are
// the entire point of the classifier.

type classifyGolden struct {
	Name     string          `json:"name"`
	Envelope Envelope        `json:"envelope"`
	Error    NormalizedError `json:"error"`
	Verdict  struct {
		Kind     VerdictKind `json:"kind"`
		Detail   string      `json:"detail"`
		Envelope Envelope    `json:"envelope"`
	} `json:"verdict"`
}

type classifyCase struct {
	Name           string          `json:"name"`
	Status         int             `json:"status"`
	Headers        map[string]string `json:"headers"`
	Body           json.RawMessage `json:"body"`
	TransportError string          `json:"transportError"`
}

func loadJSON[T any](t *testing.T, path string) []T {
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
		t.Fatalf("%s is empty — an empty golden file passes every test, which is worse than failing", path)
	}
	return out
}

func TestClassifyMatchesTheTypeScriptOracle(t *testing.T) {
	cases := loadJSON[classifyCase](t, filepath.Join("..", "..", "..", "testdata", "classify-cases.json"))
	golden := loadJSON[classifyGolden](t, filepath.Join("testdata", "classify-golden.json"))

	if len(cases) != len(golden) {
		t.Fatalf("%d inputs but %d golden results — the golden file is stale", len(cases), len(golden))
	}

	for i, c := range cases {
		want := golden[i]
		if c.Name != want.Name {
			t.Fatalf("case %d: input %q vs golden %q — the files are out of order", i, c.Name, want.Name)
		}

		t.Run(c.Name, func(t *testing.T) {
			if got := DetectEnvelope(c.Body); got != want.Envelope {
				t.Errorf("DetectEnvelope = %q, TypeScript says %q", got, want.Envelope)
			}

			if got := NormalizeError(c.Body); got != want.Error {
				t.Errorf("NormalizeError = %+v, TypeScript says %+v", got, want.Error)
			}

			v := Classify(Input{
				Status:         c.Status,
				Headers:        c.Headers,
				Body:           c.Body,
				TransportError: c.TransportError,
			})
			if v.Kind != want.Verdict.Kind {
				t.Errorf("kind = %q, TypeScript says %q", v.Kind, want.Verdict.Kind)
			}
			if v.Detail != want.Verdict.Detail {
				t.Errorf("detail = %q, TypeScript says %q", v.Detail, want.Verdict.Detail)
			}
			if v.Envelope != want.Verdict.Envelope {
				t.Errorf("verdict envelope = %q, TypeScript says %q", v.Envelope, want.Verdict.Envelope)
			}
		})
	}
}

type wireCase struct {
	Name            string `json:"name"`
	ServerName      string `json:"serverName"`
	ToolName        string `json:"toolName"`
	SlugIsAmbiguous bool   `json:"slugIsAmbiguous"`
}

type wireGolden struct {
	Name string   `json:"name"`
	Slug string   `json:"slug"`
	Wire WireName `json:"wire"`
}

func TestWireNamesMatchTheTypeScriptOracle(t *testing.T) {
	cases := loadJSON[wireCase](t, filepath.Join("..", "..", "..", "testdata", "wire-cases.json"))
	golden := loadJSON[wireGolden](t, filepath.Join("testdata", "wire-golden.json"))

	if len(cases) != len(golden) {
		t.Fatalf("%d inputs but %d golden results — the golden file is stale", len(cases), len(golden))
	}

	for i, c := range cases {
		want := golden[i]
		t.Run(c.Name, func(t *testing.T) {
			if got := ServerSlug(c.ServerName); got != want.Slug {
				t.Errorf("ServerSlug(%q) = %q, TypeScript says %q", c.ServerName, got, want.Slug)
			}
			got := WireNameFor(c.ServerName, c.ToolName, c.SlugIsAmbiguous)
			if got.Name != want.Wire.Name {
				t.Errorf("name = %q, TypeScript says %q", got.Name, want.Wire.Name)
			}
			if got.Slug != want.Wire.Slug {
				t.Errorf("slug = %q, TypeScript says %q", got.Slug, want.Wire.Slug)
			}
			// The NOTE matters as much as the name. It is what a reader sees
			// when a name cannot be derived, and a port that refuses for a
			// different stated reason is a port that misleads.
			if got.Note != want.Wire.Note {
				t.Errorf("note = %q, TypeScript says %q", got.Note, want.Wire.Note)
			}
		})
	}
}

// ── the drift check, run for real ───────────────────────────────────────────

func TestGatewaySourceHasNotDrifted(t *testing.T) {
	repo := gatewayRepo()
	reports, found := CheckGatewaySource(repo)

	if !found {
		// Skip, never pass. A green tick for a check that did not run is a
		// lie, and this is exactly the check whose whole job is to be noticed.
		t.Skipf("gateway checkout not at %s, so %d transcribed facts are UNVERIFIED. Set %s to check them.",
			repo, len(GatewayFacts), GatewayRepoEnv)
	}

	for _, r := range reports {
		t.Errorf("gateway source drifted:\n  %s", r)
	}
	if len(reports) == 0 {
		t.Logf("%d transcribed facts still match gateway source", len(GatewayFacts))
	}
}

func TestEveryTranscribedFactIsCheckable(t *testing.T) {
	// A fact with no pattern or no file silently never fails, which defeats
	// the point of recording it.
	for _, f := range GatewayFacts {
		if f.Name == "" || f.File == "" || f.Pattern == nil || f.Want == "" {
			t.Errorf("incomplete fact: %+v", f)
		}
		if f.Why == "" {
			t.Errorf("fact %q has no consequence recorded — a diff without one just gets re-recorded", f.Name)
		}
	}
}
