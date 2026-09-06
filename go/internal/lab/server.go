// Package lab is the Go half of the lab backend during the migration.
//
// # What this is for
//
// The backend is moving from TypeScript to Go one endpoint at a time. React
// talks to twenty-three endpoints and must keep working throughout, so this
// process sits in front: it serves what has been migrated and reverse-proxies
// the rest to the Node server behind it.
//
//	React :5173  ──▶  Go :8787  ──┬─▶ handled here
//	                              └─▶ proxied to Node :8789
//
// Nothing is big-bang, nothing is unreachable mid-migration, and at every point
// the tool still works. When the last endpoint moves, the proxy and the Node
// process are deleted and this becomes the whole backend.
//
// # Why a merge rather than a swap for the first endpoint
//
// The obvious first move is to reimplement an endpoint in Go and stop proxying
// it. `/api/config` looked like the candidate until it turned out to read the
// session registry — gateways and keys typed into the console and held in
// memory by Node. Serving that from Go would mean two processes with two
// different ideas of the same state, and a gateway added in one would be
// invisible in the other. A state split on day one is a bad trade for the
// appearance of progress.
//
// So `/api/health` is *merged* instead: Go calls Node's, adds its own block and
// returns the union. The existing shape is preserved exactly, so React needs no
// change, and the seam is proven to handle response transformation — which is
// what every later phase depends on.
package lab

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// BackendHeader names which process produced a response.
//
// Not decoration. During a migration the first question about any surprising
// result is "which backend answered this", and a header answers it without
// reading a log or guessing from behaviour.
const BackendHeader = "X-Lab-Backend"

// Options configures the front door.
type Options struct {
	// Addr is where this process listens — the port React already uses.
	Addr string
	// Upstream is the Node backend everything unmigrated is proxied to.
	Upstream string
	// Version is reported in the health block.
	Version string
	// Started is used for uptime.
	Started time.Time
	Log     *slog.Logger
}

// Server is the front door: migrated handlers plus a proxy for the rest.
type Server struct {
	opts     Options
	proxy    *httputil.ReverseProxy
	upstream *url.URL
	mux      *http.ServeMux
	client   *http.Client
}

// New builds the front door. It fails rather than starting half-configured: a
// proxy that cannot parse its own upstream would answer every unmigrated
// endpoint with a confusing 502 instead of saying what is wrong.
func New(opts Options) (*Server, error) {
	if opts.Log == nil {
		return nil, fmt.Errorf("lab: a logger is required")
	}
	upstream, err := url.Parse(opts.Upstream)
	if err != nil {
		return nil, fmt.Errorf("lab: upstream %q is not a URL: %w", opts.Upstream, err)
	}
	if upstream.Host == "" {
		return nil, fmt.Errorf("lab: upstream %q has no host", opts.Upstream)
	}

	s := &Server{
		opts:     opts,
		upstream: upstream,
		mux:      http.NewServeMux(),
		// Deliberately generous: the endpoints behind this proxy make real
		// provider calls, and a brokered MCP conversation was measured at
		// nine seconds. A short client timeout here would sever legitimate
		// work and look like a gateway fault.
		client: &http.Client{Timeout: 5 * time.Minute},
	}

	s.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			// Preserve the caller's Host. The lab binds loopback only and
			// nothing downstream does virtual hosting, but rewriting it would
			// make proxied and direct requests differ for no reason.
			r.Out.Host = r.In.Host
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Set(BackendHeader, "node")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// The Node backend being down is the single most likely failure
			// during the migration, so it gets a message that says so rather
			// than a bare 502 — the same lesson the TypeScript transport
			// learned about ECONNREFUSED.
			opts.Log.Error("proxy to node failed", "path", r.URL.Path, "err", err)
			w.Header().Set(BackendHeader, "go")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": fmt.Sprintf(
					"the Node backend at %s did not answer: %v. It serves every endpoint not yet migrated to Go; start it with `npm run dev:server`.",
					upstream, err,
				),
			})
		},
		// SSE must not be buffered. /api/stream relays frames as they arrive
		// and the whole point of that endpoint is when each one lands, so a
		// buffering proxy would silently destroy every timing measurement.
		FlushInterval: -1,
	}

	s.routes()
	return s, nil
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/backends", s.handleBackends)
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	// Everything else still belongs to Node.
	s.mux.Handle("/", s.proxy)
}

func (s *Server) Handler() http.Handler { return s.mux }

// Addr is where to listen.
func (s *Server) Addr() string { return s.opts.Addr }

type goBackend struct {
	Status        string `json:"status"`
	Version       string `json:"version"`
	UptimeSeconds int    `json:"uptimeSeconds"`
	Addr          string `json:"addr"`
}

type nodeBackend struct {
	Status   string `json:"status"`
	Upstream string `json:"upstream"`
	// Reason is set only when Node did not answer, and says what to do.
	Reason string `json:"reason,omitempty"`
}

func (s *Server) goBlock() goBackend {
	return goBackend{
		Status:        "healthy",
		Version:       s.opts.Version,
		UptimeSeconds: int(time.Since(s.opts.Started).Seconds()),
		Addr:          s.opts.Addr,
	}
}

// handleBackends reports the seam itself, without needing Node.
//
// Deliberately Go-only: it is the one endpoint that still answers when the
// Node half is down, which is exactly when someone wants to know what is up.
func (s *Server) handleBackends(w http.ResponseWriter, r *http.Request) {
	node := nodeBackend{Status: "unreachable", Upstream: s.upstream.String()}
	if err := s.pingUpstream(r); err == nil {
		node.Status = "healthy"
	} else {
		node.Reason = fmt.Sprintf("%v — start it with `npm run dev:server`", err)
	}

	writeJSON(w, "go", http.StatusOK, map[string]any{
		"front":    "go",
		"go":       s.goBlock(),
		"node":     node,
		"migrated": []string{"GET /api/backends", "GET /api/health"},
		"note":     "Everything not listed is proxied to Node. The " + BackendHeader + " header on any response says which process answered.",
	})
}

// handleHealth merges Node's health with this process's own.
//
// The union, not a replacement: Node still owns the exchange history and the
// session registry, so its numbers are the real ones and dropping them would
// make the console wrong. If Node is down this still answers, degraded, rather
// than failing — a health endpoint that cannot report ill health is useless.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	merged := map[string]any{}

	body, err := s.fetchUpstream(r, "/api/health")
	if err != nil {
		merged["service"] = "tokenshield-lab"
		merged["status"] = "degraded"
		merged["detail"] = fmt.Sprintf(
			"the Go front door is up; the Node backend at %s is not (%v)", s.upstream, err)
	} else if err := json.Unmarshal(body, &merged); err != nil {
		merged = map[string]any{
			"service": "tokenshield-lab",
			"status":  "degraded",
			"detail":  fmt.Sprintf("Node answered /api/health with something that is not JSON: %v", err),
		}
	}

	node := nodeBackend{Status: "healthy", Upstream: s.upstream.String()}
	if err != nil {
		node.Status = "unreachable"
		node.Reason = err.Error()
	}
	merged["backends"] = map[string]any{"go": s.goBlock(), "node": node}

	// go+node when both contributed, so the header never overstates who did
	// the work.
	which := "go+node"
	if err != nil {
		which = "go"
	}
	writeJSON(w, which, http.StatusOK, merged)
}

func (s *Server) pingUpstream(r *http.Request) error {
	_, err := s.fetchUpstream(r, "/api/health")
	return err
}

func (s *Server) fetchUpstream(r *http.Request, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.upstream.String()+path, nil)
	if err != nil {
		return nil, err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", path, res.StatusCode)
	}
	// Bounded: this is a health payload, and an unbounded read from a process
	// that might be misbehaving is how a debugging tool becomes the problem.
	return io.ReadAll(io.LimitReader(res.Body, 1<<20))
}

func writeJSON(w http.ResponseWriter, backend string, status int, v any) {
	w.Header().Set(BackendHeader, backend)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// The status line is already written, so there is nowhere to report
		// this but the log.
		slog.Error("writing json response", "err", err)
	}
}

// Listen binds and serves. Bound to loopback by the caller, never a public
// interface: this process fronts a console that holds live gateway credentials
// and has no authentication of its own.
func (s *Server) Listen() error {
	ln, err := net.Listen("tcp", s.opts.Addr)
	if err != nil {
		return fmt.Errorf("lab: cannot bind %s: %w", s.opts.Addr, err)
	}
	s.opts.Log.Info("lab front door listening",
		"addr", s.opts.Addr, "upstream", s.upstream.String())
	srv := &http.Server{
		Handler: s.mux,
		// No write timeout on purpose: /api/stream is a long-lived SSE relay
		// and a write deadline would cut it mid-conversation.
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.Serve(ln)
}
