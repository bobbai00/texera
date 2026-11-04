// Package server is the catalog's HTTP API: a generic handler set over the kind table for
// the standard methods, hand-written handlers for the actions and subresources, and the
// gateway's access checks. The OpenAPI document is the contract; the handlers are validated
// against it in tests, and every operation's permission comes from the generated table.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// Prefix is where the catalog API is mounted.
const Prefix = "/catalog/v1"

// Server serves the catalog.
type Server struct {
	svc      *catalog.Service
	resolver *auth.Resolver
	pdp      *authz.PDP
	public   string
	log      *slog.Logger
	api      *http.ServeMux
	extra    map[string]http.Handler
}

// New builds the server and registers every route.
func New(svc *catalog.Service, resolver *auth.Resolver, pdp *authz.PDP, publicURL string, log *slog.Logger) *Server {
	s := &Server{svc: svc, resolver: resolver, pdp: pdp, public: strings.TrimSuffix(publicURL, "/"), log: log, api: http.NewServeMux(), extra: map[string]http.Handler{}}
	s.routeKinds()
	s.routeResources()
	s.routeWorkflows()
	s.routeFiles()
	s.routeCompute()
	s.routeAgents()
	s.routeIAM()
	return s
}

// Mount adds a handler at a path prefix that authenticates requests itself (the MCP servers).
func (s *Server) Mount(prefix string, h http.Handler) { s.extra[prefix] = h }

// API returns the authenticated API handler, the one the MCP bridge calls in process.
func (s *Server) API() http.Handler {
	public := func(r *http.Request) bool { return r.URL.Path == Prefix+"/settings/public" }
	return s.resolver.Middleware(public)(s.api)
}

// Handler builds the HTTP handler: public endpoints, the ext_authz gate, the API behind the
// authentication middleware, and the mounted extras.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.protectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/", s.protectedResourceMetadata)
	mux.Handle("/access/v1/ext-authz", http.HandlerFunc(s.extAuthz))
	mux.Handle("/access/v1/ext-authz/", http.HandlerFunc(s.extAuthz))
	api := s.API()
	mux.Handle(Prefix+"/", api)
	mux.Handle("/lineage/", api)
	mux.Handle("/access/v1/evaluation", api)
	for prefix, h := range s.extra {
		mux.Handle(prefix, h)
		if !strings.HasSuffix(prefix, "/") {
			mux.Handle(prefix+"/", h)
		}
	}
	return logging(s.log, mux)
}

func (s *Server) protectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 s.public + "/mcp",
		"authorization_servers":    []string{s.svc.Config.OIDCIssuer},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"openid", "profile", "email"},
	})
}

// extAuthz answers the gateway's checks: every protected route needs a valid token. Units
// are not reachable through the gateway; what a caller may do is decided by the route itself.
func (s *Server) extAuthz(w http.ResponseWriter, r *http.Request) {
	caller, err := s.resolver.Resolve(r.Context(), r)
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="texera"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if caller.Principal != nil {
		w.Header().Set("X-Texera-Principal", caller.PID().String())
	}
	w.WriteHeader(http.StatusOK)
}

// handlerFunc is a handler that answers with an error the server renders.
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

// handle registers a route of the API.
func (s *Server) handle(pattern string, fn handlerFunc) {
	s.api.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			s.writeError(w, r, err)
		}
	})
}

// Routes lists the registered method+path patterns, for the coverage test.
func (s *Server) Match(r *http.Request) string {
	_, pattern := s.api.Handler(r)
	return pattern
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ce *catalog.Error
	switch {
	case errors.As(err, &ce):
		body := api.Error{Code: ce.Code, Message: ce.Message}
		if ce.Details != nil {
			body.Details = &ce.Details
		}
		writeJSON(w, ce.Status, body)
	case errors.Is(err, ports.ErrUnauthenticated):
		w.Header().Set("WWW-Authenticate", `Bearer realm="texera"`)
		writeJSON(w, http.StatusUnauthorized, api.Error{Code: "unauthenticated", Message: err.Error()})
	case errors.Is(err, authz.ErrForbidden):
		writeJSON(w, http.StatusForbidden, api.Error{Code: "forbidden", Message: "the caller may not do this"})
	case errors.Is(err, store.ErrNotFound):
		writeJSON(w, http.StatusNotFound, api.Error{Code: "not_found", Message: err.Error()})
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeJSON(w, http.StatusInternalServerError, api.Error{Code: "internal", Message: "internal error"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// decode reads a JSON body.
func decode(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return catalog.Invalid("reading the body: "+err.Error(), nil)
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return catalog.Invalid("a JSON body is required", nil)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return catalog.Invalid("the body is not valid JSON: "+err.Error(), nil)
	}
	return nil
}

func callerOf(r *http.Request) *auth.Caller { return auth.CallerFrom(r.Context()) }

func ridParam(r *http.Request, name string) (uuid.UUID, error) {
	raw := r.PathValue(name)
	rid, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, catalog.NotFound(name + " " + raw)
	}
	return rid, nil
}

func intParam(r *http.Request, name string) (int, error) {
	raw := r.PathValue(name)
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, catalog.Invalid(name+" must be a non-negative integer", nil)
	}
	return n, nil
}

func queryInt(r *http.Request, name string, def int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

func queryRid(r *http.Request, name string) (*uuid.UUID, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return nil, nil
	}
	rid, err := uuid.Parse(raw)
	if err != nil {
		return nil, catalog.Invalid(name+" is not a resource id", nil)
	}
	return &rid, nil
}

func envelopes(rs []store.Resource) []api.Resource {
	out := make([]api.Resource, 0, len(rs))
	for i := range rs {
		out = append(out, catalog.Envelope(&rs[i]))
	}
	return out
}

func page(rs []store.Resource, next string) api.ResourcePage {
	p := api.ResourcePage{Items: envelopes(rs)}
	if next != "" {
		p.NextCursor = &next
	}
	return p
}

func ctxOf(r *http.Request) context.Context { return r.Context() }

func logging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Debug("http", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Flush lets streaming handlers flush through the recorder.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
