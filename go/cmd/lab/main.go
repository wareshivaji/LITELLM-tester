// Command lab is the Go front door for the TokenShield client lab.
//
// It serves the endpoints already migrated to Go and proxies the rest to the
// Node backend. See package lab for why the migration works this way.
//
// Usage:
//
//	lab                                  # :8787, proxying to :8789
//	lab -addr 127.0.0.1:8787 -upstream http://127.0.0.1:8789
//	lab check                            # CI: verify transcribed gateway facts
//	lab diff  -cases f.json              # send the same requests to two backends and diff
package main

import (
	"flag"
	"log/slog"
	"os"
	"time"

	"github.com/cloudgov/tokenshield-lab/internal/lab"
)

// version is stamped at build time with -ldflags, and is only cosmetic.
var version = "0.1.0-dev"

func main() {
	// Subcommands before flags: `lab check` is the CI entry point and must not
	// need the serve flags to be valid.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "check":
			os.Exit(runCheck(os.Args[2:]))
		case "diff":
			os.Exit(runDiff(os.Args[2:]))
		}
	}

	// Loopback by default and in practice always: this fronts a console
	// holding live gateway credentials with no authentication of its own.
	// Making the bind address a flag rather than a constant is a convenience
	// for tests, not an invitation to expose it.
	addr := flag.String("addr", "127.0.0.1:8787", "address to listen on (loopback only)")
	upstream := flag.String("upstream", "http://127.0.0.1:8789", "the Node backend serving unmigrated endpoints")
	flag.Parse()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	server, err := lab.New(lab.Options{
		Addr:     *addr,
		Upstream: *upstream,
		Version:  version,
		Started:  time.Now(),
		Log:      log,
	})
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}

	if err := server.Listen(); err != nil {
		// A bind failure is the common case here and usually means an old
		// process still holds the port. Saying so beats a bare error.
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
