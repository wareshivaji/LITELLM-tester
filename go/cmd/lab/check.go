package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/cloudgov/tokenshield-lab/internal/contract"
)

// `lab check` — the CI mode.
//
// One binary, one exit code, no node_modules. This is the concrete meaning of
// "scaling" for this tool: today it exists on one laptop and is run by hand.
//
// It checks the one thing that cannot be checked by a unit test, because it
// depends on a repository outside this one: whether the values transcribed from
// gateway source still match that source. Everything else is covered by
// `go test`.
//
// Exit codes are the interface:
//
//	0  every transcribed fact still matches
//	1  at least one has drifted — the gateway changed under us
//	2  the gateway checkout was not found, so nothing was verified
//
// 2 is deliberately not 0. A CI job that cannot find the gateway has not
// passed this check, it has skipped it, and reporting a skip as a pass is how a
// drift sits unnoticed for weeks — which is the exact failure this whole
// mechanism exists to prevent.
func runCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	repo := fs.String("gateway", "", "path to the cloudgov-ai-gateway checkout (default: ../../../cloudgov-ai-gateway, or $"+contract.GatewayRepoEnv+")")
	quiet := fs.Bool("quiet", false, "print only on failure")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	path := *repo
	if path == "" {
		path = os.Getenv(contract.GatewayRepoEnv)
	}
	if path == "" {
		path = "../../cloudgov-ai-gateway"
	}

	reports, found := contract.CheckGatewaySource(path)

	if !found {
		fmt.Fprintf(os.Stderr,
			"NOT VERIFIED: no gateway checkout at %s, so %d transcribed facts were not checked.\n"+
				"  Point at one with -gateway or $%s. Exiting 2 rather than 0: a skipped check is not a passed check.\n",
			path, len(contract.GatewayFacts), contract.GatewayRepoEnv)
		return 2
	}

	if len(reports) > 0 {
		fmt.Fprintf(os.Stderr, "DRIFT: %d of %d transcribed facts no longer match gateway source.\n\n",
			len(reports), len(contract.GatewayFacts))
		for _, r := range reports {
			fmt.Fprintf(os.Stderr, "  %s\n\n", r)
		}
		fmt.Fprintf(os.Stderr,
			"The gateway changed and the lab still encodes the old value. Update the constant AND\n"+
				"the recorded Want in internal/contract/sourcecheck.go, then re-run.\n")
		return 1
	}

	if !*quiet {
		fmt.Printf("ok: %d transcribed facts still match gateway source at %s\n",
			len(contract.GatewayFacts), path)
	}
	return 0
}
