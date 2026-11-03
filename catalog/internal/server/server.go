// Package server implements the catalog's HTTP API: the generated strict server interface
// over the store, the policy decision point, the units, the dataset object store and the
// MCP server.
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/config"
	"github.com/apache/texera/catalog/internal/datasets"
	"github.com/apache/texera/catalog/internal/store"
)

// Server holds the catalog's dependencies.
type Server struct {
	cfg      config.Config
	store    *store.Store
	pdp      *authz.PDP
	drainer  *authz.Drainer
	verifier *authn.Verifier
	tokens   *authn.ServiceTokenSource
	files    *datasets.Store
	log      *slog.Logger

	// system is the platform principal that owns built-in resources.
	system *store.Principal

	opsMu     sync.Mutex
	opsCache  *api.OperatorTypeList
	opsCached time.Time

	// extra handlers mounted beside the generated API (the MCP server).
	extra map[string]http.Handler
}

// Deps are the dependencies New needs.
type Deps struct {
	Config   config.Config
	Store    *store.Store
	PDP      *authz.PDP
	Drainer  *authz.Drainer
	Verifier *authn.Verifier
	Tokens   *authn.ServiceTokenSource
	Files    *datasets.Store
	Log      *slog.Logger
}

// New builds a Server.
func New(d Deps) *Server {
	return &Server{
		cfg: d.Config, store: d.Store, pdp: d.PDP, drainer: d.Drainer, verifier: d.Verifier, tokens: d.Tokens, files: d.Files, log: d.Log,
		extra: map[string]http.Handler{},
	}
}

// Mount adds a handler at a path prefix (e.g. "/mcp") that authenticates requests itself (the
// MCP handler answers 401 with the protected-resource metadata pointer the MCP spec requires).
func (s *Server) Mount(prefix string, h http.Handler) { s.extra[prefix] = h }

var _ api.StrictServerInterface = (*Server)(nil)

// Handler builds the HTTP handler: public endpoints, the ext_authz gate, the generated
// API behind the authentication middleware, and the mounted extras.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/access/v1/ext-authz/", authz.ExtAuthzHandler(s.verifier, s.pdp, "/access/v1/ext-authz"))
	mux.Handle("/access/v1/ext-authz", authz.ExtAuthzHandler(s.verifier, s.pdp, "/access/v1/ext-authz"))
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.protectedResourceMetadata)
	mux.HandleFunc("GET /.well-known/oauth-protected-resource/", s.protectedResourceMetadata)

	strict := api.NewStrictHandlerWithOptions(s, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  requestErrorHandler,
		ResponseErrorHandlerFunc: responseErrorHandler(s.log),
	})
	apiHandler := api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter: http.NewServeMux(),
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			requestErrorHandler(w, r, err)
		},
	})
	authed := s.verifier.Middleware(nil)
	mux.Handle("/catalog/", authed(apiHandler))
	mux.Handle("/lineage/", authed(apiHandler))
	mux.Handle("/access/v1/evaluation", authed(apiHandler))
	for prefix, h := range s.extra {
		mux.Handle(prefix, h)
		if !strings.HasSuffix(prefix, "/") {
			mux.Handle(prefix+"/", h)
		}
	}
	return logging(s.log, mux)
}

func (s *Server) protectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"resource":                 s.cfg.PublicURL + "/mcp",
		"authorization_servers":    []string{s.cfg.OIDCIssuer},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"openid", "profile", "email"},
	})
}

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

// Flush lets streaming handlers (SSE) flush through the recorder.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// callerOf returns the authenticated caller or an unauthenticated problem.
func callerOf(ctx context.Context) (*authn.Caller, error) {
	c := authn.CallerFrom(ctx)
	if c == nil || c.Principal == nil {
		return nil, &Problem{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: "a valid bearer token is required"}
	}
	return c, nil
}

// loadResource fetches a live resource of an expected kind (empty kind accepts any) and
// checks the action on it.
func (s *Server) loadResource(ctx context.Context, caller *authn.Caller, ridStr string, kind string, action authz.Action) (*store.Resource, error) {
	rid, err := parseRid(ridStr)
	if err != nil {
		return nil, err
	}
	r, err := s.store.GetResource(ctx, rid)
	if err != nil {
		if store.IsNotFound(err) {
			return nil, notFound("resource " + ridStr)
		}
		return nil, err
	}
	if kind != "" && r.Kind != kind {
		return nil, notFound(kind + " " + ridStr)
	}
	if err := s.pdp.Require(ctx, caller, action, rid); err != nil {
		return nil, err
	}
	return r, nil
}

// homeProject returns the caller's home project, creating it on first use.
func (s *Server) homeProject(ctx context.Context, p *store.Principal) (*store.Resource, error) {
	rs, err := s.store.SearchResources(ctx, store.ResourceFilter{Kind: "project", ReadableBy: &p.PID, Limit: 100})
	if err != nil {
		return nil, err
	}
	for i := range rs {
		if rs[i].OwnerPID == p.PID && rs[i].Labels["texera.home"] == "true" {
			return &rs[i], nil
		}
	}
	name := p.DisplayName
	if name == "" {
		name = "home"
	}
	r, _, err := s.store.CreateResource(ctx, store.NewResource{
		Kind: "project", Name: name + "'s home", OwnerPID: p.PID, CreatedByPID: p.PID,
		Labels: map[string]string{"texera.home": "true"},
	})
	if err != nil {
		return nil, err
	}
	s.drainer.Kick()
	return r, nil
}

// resolveProject returns the project a new resource goes into: the given one (checked for
// write) or the caller's home project.
func (s *Server) resolveProject(ctx context.Context, caller *authn.Caller, project *api.Rid) (uuid.UUID, error) {
	if project != nil && *project != "" {
		r, err := s.loadResource(ctx, caller, *project, "project", authz.ActionWrite)
		if err != nil {
			return uuid.Nil, err
		}
		return r.RID, nil
	}
	home, err := s.homeProject(ctx, caller.Principal)
	if err != nil {
		return uuid.Nil, err
	}
	return home.RID, nil
}

// Seed creates the platform principal and the built-in resources: the static unit of the
// dev stack, the built-in MCP server and the default agent templates. It is idempotent.
func (s *Server) Seed(ctx context.Context) error {
	sys, _, err := s.store.EnsureUser(ctx, "system:texera", "Texera", nil)
	if err != nil {
		return err
	}
	s.system = sys
	find := func(kind, name string) (*store.Resource, error) {
		rs, err := s.store.SearchResources(ctx, store.ResourceFilter{Kind: kind, Query: name, Limit: 50})
		if err != nil {
			return nil, err
		}
		for i := range rs {
			if rs[i].OwnerPID == sys.PID && rs[i].Name == name {
				return &rs[i], nil
			}
		}
		return nil, nil
	}
	create := func(kind, name, desc string, spec any, content any, contentKind string) (*store.Resource, error) {
		existing, err := find(kind, name)
		if err != nil || existing != nil {
			return existing, err
		}
		var c json.RawMessage
		if content != nil {
			c = mustJSON(content)
		}
		r, _, err := s.store.CreateResource(ctx, store.NewResource{
			Kind: kind, Name: name, Description: &desc, Visibility: "public", OwnerPID: sys.PID, CreatedByPID: sys.PID,
			Labels: map[string]string{"texera.builtin": "true"}, Spec: mustJSON(spec), Content: c, ContentKind: contentKind,
		})
		if err != nil {
			return nil, err
		}
		s.log.Info("seeded", "kind", kind, "name", name, "rid", r.RID)
		return r, nil
	}
	if s.cfg.StaticUnitEndpoint != "" {
		spec := api.ComputingUnitSpec{UnitKind: api.Static, Endpoint: &s.cfg.StaticUnitEndpoint}
		unit, err := create("computing_unit", s.cfg.StaticUnitName, "The computing unit of this deployment", spec, nil, "")
		if err != nil {
			return err
		}
		// Reconcile the endpoint when the deployment moved the unit.
		var current api.ComputingUnitSpec
		_ = json.Unmarshal(unit.Spec, &current)
		if current.Endpoint == nil || *current.Endpoint != s.cfg.StaticUnitEndpoint {
			if _, err := s.store.UpdateSpec(ctx, unit.RID, mustJSON(spec)); err != nil {
				return err
			}
			s.log.Info("static unit endpoint updated", "rid", unit.RID, "endpoint", s.cfg.StaticUnitEndpoint)
		}
	}
	mcpURL := s.cfg.PublicURL + "/mcp"
	builtin := true
	mcpSrv, err := create("mcp_server", "texera", "The Texera dataflow MCP server: operators, workflows, compilation, execution, results, datasets",
		api.McpServerSpec{Transport: api.StreamableHttp, Url: &mcpURL, Builtin: &builtin}, api.McpServerSpec{Transport: api.StreamableHttp, Url: &mcpURL, Builtin: &builtin}, "json")
	if err != nil {
		return err
	}
	env, err := create("environment", "python-default", "Python with pandas, numpy and scikit-learn",
		api.EnvironmentSpec{Python: &api.PythonEnvironment{Packages: []string{"pandas", "numpy", "scikit-learn"}}},
		api.EnvironmentSpec{Python: &api.PythonEnvironment{Packages: []string{"pandas", "numpy", "scikit-learn"}}}, "json")
	if err != nil {
		return err
	}
	_ = env
	mcpRef := mcpSrv.RID.String()
	model := api.ModelSpec{Name: "claude-haiku-5-5"}
	templates := []struct {
		name, desc, prompt string
	}{
		{"Data Analyst", "Analyzes datasets by building and running Texera workflows", dataAnalystPrompt},
		{"General", "A general assistant with the Texera tools", generalPrompt},
	}
	for _, t := range templates {
		spec := api.AgentTemplateSpec{
			Card:    api.AgentCard{Name: t.name, Description: t.desc},
			Model:   &model,
			Prompts: &map[string]string{"system": t.prompt},
			Tools: &struct {
				Mcp       *[]api.McpBinding `json:"mcp,omitempty"`
				Operators *[]string         `json:"operators,omitempty"`
			}{Mcp: &[]api.McpBinding{{Server: mcpRef}}},
		}
		r, err := create("agent_template", t.name, t.desc, spec, spec, "json")
		if err != nil {
			return err
		}
		// Built-in templates follow the platform: when the shipped spec changes, the template gets a
		// new version authored by the platform. People customize a copy, not the built-in.
		if raw := mustJSON(spec); !sameJSON(r.Spec, raw) {
			if _, err := s.store.UpdateSpec(ctx, r.RID, raw); err != nil {
				return err
			}
			msg := "updated by the platform"
			if _, err := s.store.CreateVersion(ctx, store.NewVersion{RID: r.RID, ContentKind: "json", Content: raw, Message: &msg, CreatedByPID: sys.PID}); err != nil {
				return err
			}
			s.log.Info("built-in template updated", "name", t.name, "rid", r.RID)
		}
	}
	s.drainer.Kick()
	return nil
}

const dataAnalystPrompt = `You are Texera's data analyst. You answer data questions by building and running Texera
workflows with the Texera MCP tools, never by guessing.

Work like this:
1. Find the data: search_resources (kind dataset) and list_dataset_files; read_dataset_file to see a CSV header.
2. Look up operators with list_operators before using them; use exact operatorType values and the
   property names from each operator's JSON Schema.
3. Create a workflow with create_workflow. The content format is
   {"operators":[{"operatorID":"<id>","operatorType":"<type>","operatorProperties":{...},
     "inputPorts":[{"portID":"input-0"}],"outputPorts":[{"portID":"output-0"}]}],
    "links":[{"linkID":"l1","source":{"operatorID":"a","portID":"output-0"},"target":{"operatorID":"b","portID":"input-0"}}]}.
   A CSV scan reads a dataset file through its URI: set its fileName property to
   dataset://<dataset rid>@<version>/<path> as returned by list_dataset_files.
4. validate_workflow and fix every reported error; then run_workflow with waitSeconds so you get the
   results; read results with get_port_result when you need the rows.
5. Report the findings in plain language and mention the workflow and execution you produced.
6. When the person wants to keep a result, save it with save_result_as_dataset: it becomes a dataset
   version that later workflows can read, and its lineage records the run that produced it.

Edit existing workflows with edit_workflow (an RFC 6902 patch to the content); every edit is a new version.`

const generalPrompt = `You are a helpful assistant inside Texera, a collaborative data science workspace. You have
tools to search the catalog, read datasets, list operators, build and run workflows, read
results and save them as datasets. Prefer tools over guesses; be concise; cite the resources you
created.`

// sameJSON reports whether two JSON documents hold the same value, whatever their key order.
func sameJSON(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
