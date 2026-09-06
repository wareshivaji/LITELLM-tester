// Command lab is a two-command CLI for the TokenShield client lab.
//
//	lab check                 verify the gateway facts transcribed into this repo
//	lab diff  -cases f.json   send the same requests to two backends and diff them
//
// It is deliberately NOT a server. An earlier plan migrated the lab's Node
// backend to Go for "future scaling"; that was abandoned once it was clear the
// lab is a loopback tool on one machine and the migration bought nothing a
// customer would ever see. The Node/TypeScript backend serves the app.
//
// What survived is the part with no TypeScript equivalent: a differ that sends
// one request to two gateways and reports where they disagree, and a check that
// catches gateway facts transcribed into this repo drifting from the gateway's
// own source. Both are CLI-shaped and neither belongs in the web app.
package main

import (
	"fmt"
	"os"
)

// version is stamped at build time with -ldflags, and is only cosmetic.
var version = "0.1.0-dev"

func usage() {
	fmt.Fprintf(os.Stderr, `lab %s — TokenShield client lab CLI

  lab check [-gateway PATH]     verify transcribed gateway facts against source
  lab diff  -cases FILE [...]   send the same requests to two backends and diff

Run a subcommand with -h for its flags.
`, version)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "check":
		os.Exit(runCheck(os.Args[2:]))
	case "diff":
		os.Exit(runDiff(os.Args[2:]))
	case "-h", "--help", "help":
		usage()
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "lab: unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}
