package contract

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// This file is the achievable half of G1.
//
// Importing the gateway's types is impossible from here — `internal/`, see
// doc.go — so instead every value transcribed from gateway source records where
// it came from, and `TestGatewaySourceHasNotDrifted` re-reads that source and
// fails when it no longer says what we recorded.
//
// The distinction that matters: an import makes drift *impossible*, this makes
// it *loud*. All three transcription corrections this session were "the source
// changed and nobody noticed", not "someone typed it wrong". Loud is enough to
// fix that, and unlike an import it needs nothing from another team.

// GatewayRepo is where the gateway checkout is expected, relative to this repo.
// Overridable so the check can run anywhere, and skipped entirely when absent —
// a CI box without the gateway should not fail this suite, it should say the
// check did not run. A green tick for a check that was skipped is a lie.
const GatewayRepoEnv = "TSLAB_GATEWAY_REPO"

func gatewayRepo() string {
	if v := os.Getenv(GatewayRepoEnv); v != "" {
		return v
	}
	return filepath.Join("..", "..", "..", "..", "cloudgov-ai-gateway")
}

// SourceFact is one value read out of gateway source, with the evidence.
type SourceFact struct {
	// Name of the thing, for the failure message.
	Name string
	// File, relative to the gateway repo root.
	File string
	// Pattern whose first capture group is the value we depend on.
	Pattern *regexp.Regexp
	// Want is what the value was when this was written down.
	Want string
	// Why the lab cares — printed on failure, because a diff without a
	// consequence just gets re-recorded by the next person.
	Why string
}

// GatewayFacts is everything this package transcribed from gateway source.
//
// Each entry is a promise: "the lab behaves this way because the gateway source
// said this". When the source stops saying it, the promise is broken and the
// test says which one and what it costs.
var GatewayFacts = []SourceFact{
	{
		Name:    "wire-name separator",
		File:    filepath.Join("internal", "mcp", "loop.go"),
		Pattern: regexp.MustCompile(`name\s*:?=\s*capName\(ns\s*\+\s*"([^"]+)"\s*\+\s*tool\)`),
		Want:    "__",
		Why: "The wire name is the only name the model sees and the only one a forced-call test can use. " +
			"wireNameFor() in packages/client/src/mcp.ts joins with this exact string; a change silently breaks " +
			"every derived name shown on Connect.",
	},
	{
		Name:    "wire-name length cap",
		File:    filepath.Join("internal", "mcp", "loop.go"),
		Pattern: regexp.MustCompile(`maxToolNameLen\s*=\s*(\d+)`),
		Want:    "64",
		Why: "Past this the gateway truncates and appends a digest we cannot derive. wireNameFor() in " +
			"packages/client/src/mcp.ts reports 'not derivable' at exactly this length; if the cap moves, " +
			"it starts either lying or over-refusing.",
	},
	{
		Name:    "tool-name sanitiser",
		File:    filepath.Join("internal", "mcp", "loop.go"),
		Pattern: regexp.MustCompile(`toolNameSanitizer\s*=\s*regexp\.MustCompile\(` + "`" + `([^` + "`" + `]+)` + "`" + `\)`),
		Want:    `[^a-zA-Z0-9_-]`,
		Why: "wireNameFor() in packages/client/src/mcp.ts replaces characters outside this class with " +
			"underscores. A wider class here means derived names diverge from what the model was offered.",
	},
}

// DriftReport is one fact that no longer matches its source.
type DriftReport struct {
	Fact  SourceFact
	Found string
	Err   error
}

func (d DriftReport) String() string {
	if d.Err != nil {
		return fmt.Sprintf("%s (%s): could not read the source — %v", d.Fact.Name, d.Fact.File, d.Err)
	}
	return fmt.Sprintf(
		"%s (%s)\n    recorded: %q\n    source now says: %q\n    why it matters: %s",
		d.Fact.Name, d.Fact.File, d.Fact.Want, d.Found, d.Fact.Why,
	)
}

// CheckGatewaySource re-reads the gateway and reports every fact that moved.
//
// The bool is whether the gateway was found at all. False means the check did
// not run — distinct from running and passing, and the caller must not treat
// the empty slice as a green tick.
func CheckGatewaySource(repo string) (reports []DriftReport, found bool) {
	if info, err := os.Stat(repo); err != nil || !info.IsDir() {
		return nil, false
	}

	for _, fact := range GatewayFacts {
		path := filepath.Join(repo, fact.File)
		src, err := os.ReadFile(path) //nolint:gosec // a path we constructed
		if err != nil {
			reports = append(reports, DriftReport{Fact: fact, Err: err})
			continue
		}
		m := fact.Pattern.FindSubmatch(src)
		if m == nil {
			reports = append(reports, DriftReport{
				Fact:  fact,
				Found: "(pattern no longer matches anything in the file)",
			})
			continue
		}
		got := string(m[1])
		if got != fact.Want {
			reports = append(reports, DriftReport{Fact: fact, Found: got})
		}
	}
	return reports, true
}

// DescribeSourceCheck explains the state of the check, for a report or a log.
func DescribeSourceCheck(repo string) string {
	reports, found := CheckGatewaySource(repo)
	if !found {
		return fmt.Sprintf(
			"gateway source not found at %s, so %d transcribed facts are UNVERIFIED. "+
				"Set %s to check them.",
			repo, len(GatewayFacts), GatewayRepoEnv)
	}
	if len(reports) == 0 {
		return fmt.Sprintf("%d transcribed facts still match gateway source at %s.", len(GatewayFacts), repo)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d of %d transcribed facts have DRIFTED:\n", len(reports), len(GatewayFacts))
	for _, r := range reports {
		fmt.Fprintf(&b, "  - %s\n", r)
	}
	return b.String()
}
