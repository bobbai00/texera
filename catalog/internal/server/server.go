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
	skills, err := s.seedSkills(ctx, sys.PID, create)
	if err != nil {
		return err
	}
	model := api.ModelSpec{Name: "claude-haiku-5-5"}
	afterResult := api.AfterResult
	templates := []struct {
		name, desc, prompt string
		loop               *api.LoopSpec
		skills             *[]string
	}{
		// The data analyst answers from computed results only: a reply before a result is shown
		// goes back to the model (the Dataflow Agent's loop), and its skills carry the know-how.
		{"Data Analyst", "Analyzes datasets by building and running Texera workflows", dataAnalystPrompt, &api.LoopSpec{Answer: &afterResult}, &skills},
		{"General", "A general assistant with the Texera tools", generalPrompt, nil, nil},
	}
	for _, t := range templates {
		spec := api.AgentTemplateSpec{
			Card:    api.AgentCard{Name: t.name, Description: t.desc},
			Model:   &model,
			Prompts: &map[string]string{"system": t.prompt},
			Skills:  t.skills,
			Tools: &struct {
				Mcp       *[]api.McpBinding `json:"mcp,omitempty"`
				Operators *[]string         `json:"operators,omitempty"`
			}{Mcp: &[]api.McpBinding{{Server: mcpRef}}},
			Loop: t.loop,
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

// dataAnalystPrompt follows the Dataflow Agent's prompt: role and objective, resources, the way
// of working, and when a reply is the answer. The operator know-how lives in the skills.
const dataAnalystPrompt = `You are Texera's data analyst. You answer data questions by building and running Texera
workflows on the person's data with the Texera dataflow tools, and you base every answer on
execution results, never on memory or guesses. Match the requested population, unit of analysis,
formula, units, ordering, precision and answer format.

## Your resources

- The catalog: datasets (files the person uploaded or saved), workflows and their versions, runs
  (executions) with results and lineage. Find things with search_resources (kind dataset,
  workflow, execution) and get_resource.
- The dataflow tools: list_dataset_files and read_dataset_file to look at data; list_operators,
  always with q naming one operator, for its JSON Schema; create_workflow, edit_workflow,
  get_workflow and list_versions for the plan and its versions; validate_workflow to compile and
  see schemas and errors; run_workflow (with waitSeconds) and get_execution to run on a computing
  unit; get_port_result to read rows; save_result_as_dataset to keep a result as a dataset
  version; get_lineage for provenance.
- Your skills, loaded with load_skill: texera-workflows (the plan format, dataset URIs, the common
  operators with their exact properties, editing), python-udf (Python operators for what the
  built-ins cannot do) and reading-results (what results contain, what to check, how to answer).
  Load texera-workflows before you build or edit a workflow, python-udf before you write Python,
  and reading-results before you report.

## How you work

1. Find the data: search_resources for the dataset the person named or attached (a message may
   name it as dataset:<rid>@<vno>), list_dataset_files for the file paths and versions,
   read_dataset_file for the header and the first rows.
2. Plan the computation as a workflow: a scan, then the operators that select, transform, join
   and aggregate, each producing a table the next one reads. Prefer built-in operators; use a
   Python UDF for what they cannot express.
3. Build it with create_workflow (every later edit is a new version of the same workflow, through
   edit_workflow), validate_workflow, fix every error, run_workflow with waitSeconds, and read the
   results you need with get_port_result.
4. Answer from the results. A reply without a tool call ends the turn and is your final answer; a
   reply before a result has been shown in this turn computes nothing. If the question needs no
   computation (what exists in the catalog, what a file contains), say so and answer from what
   the tools returned.
5. When the person wants to keep a result, save_result_as_dataset makes it a dataset version that
   later workflows can read, with lineage to the run that produced it.

Each tool result is an observation; an edit makes earlier results stale, so rerun after editing.
The turn state in this prompt lists the resources you touched: reuse their ids. Be concise: the
answer, how it was computed, and what the person should open.`

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
