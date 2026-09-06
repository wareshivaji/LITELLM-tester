package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/cloudgov/tokenshield-lab/internal/diff"
)

// `lab diff` — send the same requests to two backends and report where they
// disagree.
//
// Two uses, one command:
//
//	# the migration gate — is the Go handler safe to switch on?
//	lab diff -a http://127.0.0.1:8787 -b http://127.0.0.1:8789 -cases testdata/diff-cases.json
//
//	# the reference comparison — where does the gateway differ from LiteLLM?
//	lab diff -a https://gateway.cloudgov.ai -b http://127.0.0.1:4001 \
//	         -a-header "Authorization: Bearer cg-ak-…" \
//	         -b-header "x-litellm-api-key: sk-1234" -cases testdata/reference-cases.json
//
// Exit codes:
//
//	0  every case agreed
//	1  at least one differed
//	2  the run could not be performed at all
//
// An endpoint is migrated only when this exits 0, which makes the diff the gate
// rather than a report someone reads afterwards.

type headerFlag map[string]string

func (h headerFlag) String() string { return fmt.Sprintf("%v", map[string]string(h)) }

func (h headerFlag) Set(v string) error {
	for i := 0; i < len(v); i++ {
		if v[i] == ':' {
			key := v[:i]
			val := v[i+1:]
			for len(val) > 0 && val[0] == ' ' {
				val = val[1:]
			}
			if key == "" {
				return fmt.Errorf("header %q has no name", v)
			}
			h[key] = val
			return nil
		}
	}
	return fmt.Errorf("header %q is not Name: value", v)
}

func runDiff(args []string) int {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	aURL := fs.String("a", "http://127.0.0.1:8787", "base URL of the first backend")
	bURL := fs.String("b", "http://127.0.0.1:8789", "base URL of the second backend")
	aName := fs.String("a-name", "a", "label for the first backend in the report")
	bName := fs.String("b-name", "b", "label for the second backend")
	casesPath := fs.String("cases", "", "JSON file of cases to send (required)")
	pause := fs.Duration("pause", 0, "wait between the two calls; use it when both share a rate limit or budget")
	asJSON := fs.Bool("json", false, "emit the full report as JSON")
	showIgnored := fs.Bool("show-ignored", false, "list the volatile paths that were hidden")

	aHeaders := headerFlag{}
	bHeaders := headerFlag{}
	fs.Var(aHeaders, "a-header", "header for the first backend, repeatable (Name: value)")
	fs.Var(bHeaders, "b-header", "header for the second backend, repeatable")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *casesPath == "" {
		fmt.Fprintln(os.Stderr, "lab diff: -cases is required")
		fs.Usage()
		return 2
	}

	raw, err := os.ReadFile(*casesPath) //nolint:gosec // an operator-supplied path
	if err != nil {
		fmt.Fprintf(os.Stderr, "lab diff: cannot read %s: %v\n", *casesPath, err)
		return 2
	}
	var cases []diff.Case
	if err := json.Unmarshal(raw, &cases); err != nil {
		fmt.Fprintf(os.Stderr, "lab diff: %s is not a list of cases: %v\n", *casesPath, err)
		return 2
	}
	if len(cases) == 0 {
		// A zero-case run would exit 0 and mean nothing, which is the worst
		// possible outcome for something used as a migration gate.
		fmt.Fprintf(os.Stderr, "lab diff: %s has no cases — an empty run would pass and prove nothing\n", *casesPath)
		return 2
	}
	for i, c := range cases {
		if c.Method == "" {
			cases[i].Method = "GET"
		}
		if c.Name == "" {
			cases[i].Name = cases[i].Method + " " + c.Path
		}
	}

	runner := diff.NewRunner(
		diff.Target{Name: *aName, BaseURL: *aURL, Headers: aHeaders},
		diff.Target{Name: *bName, BaseURL: *bURL, Headers: bHeaders},
	)
	runner.Pause = *pause

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	fmt.Printf("%s  %s\n%s  %s\n%d cases\n\n", *aName, *aURL, *bName, *bURL, len(cases))
	summary := runner.RunAll(ctx, cases)

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(summary); err != nil {
			fmt.Fprintf(os.Stderr, "lab diff: %v\n", err)
			return 2
		}
	} else {
		fmt.Print(summary.Text())
		if *showIgnored {
			fmt.Printf("\n  volatile paths hidden: %v\n", summary.IgnoredPaths())
		}
	}

	if summary.Differ > 0 {
		return 1
	}
	return 0
}
