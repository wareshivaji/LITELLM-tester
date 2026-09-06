package contract

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every fact must explain what breaks if it drifts. A fact without a reason is
// indistinguishable from a fact someone added and forgot, and the whole value
// of this check is that a failure tells you what it costs.
func TestEveryFactSaysWhatItCosts(t *testing.T) {
	if len(GatewayFacts) == 0 {
		t.Fatal("no facts — this check would pass while verifying nothing")
	}
	for _, f := range GatewayFacts {
		if strings.TrimSpace(f.Why) == "" {
			t.Errorf("fact %q has no Why", f.Name)
		}
		if f.Want == "" {
			t.Errorf("fact %q has no expected value", f.Name)
		}
		if f.Pattern == nil || f.Pattern.NumSubexp() < 1 {
			t.Errorf("fact %q needs a capturing group to extract a value", f.Name)
		}
	}
}

// The facts are transcribed from the gateway's source, so this repo must say
// where they came from — otherwise re-verifying them means finding the file
// again by hand.
func TestEveryFactNamesItsSourceFile(t *testing.T) {
	for _, f := range GatewayFacts {
		if f.File == "" {
			t.Errorf("fact %q does not name a source file", f.Name)
		}
	}
}

// The real check, run only when a gateway checkout is present.
//
// It SKIPS rather than passes when the gateway is absent. A pass here would be
// the worst outcome: CI would go green having verified nothing, which is
// exactly the failure this check exists to prevent.
func TestGatewaySourceHasNotDrifted(t *testing.T) {
	path := os.Getenv(GatewayRepoEnv)
	if path == "" {
		path = filepath.Join("..", "..", "..", "..", "cloudgov-ai-gateway")
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no gateway checkout at %s (set %s) — skipping rather than passing, "+
			"because a pass here would mean CI verified nothing", path, GatewayRepoEnv)
	}

	reports, found := CheckGatewaySource(path)
	if !found {
		t.Skipf("gateway checkout at %s did not contain the expected files", path)
	}
	for _, r := range reports {
		t.Errorf("drifted: %s\n  want %q, source has %q\n  %s",
			r.Fact.Name, r.Fact.Want, r.Found, r.Fact.Why)
	}
}
