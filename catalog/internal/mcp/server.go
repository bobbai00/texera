package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	texauth "github.com/apache/texera/catalog/internal/auth"
)

// Handler serves the catalog's MCP server over streamable HTTP. A tool call becomes the HTTP
// request of its operation, answered by the catalog's API handler in process with the caller's
// own bearer token, so the tools and the REST API cannot disagree.
func Handler(api http.Handler, resolver *texauth.Resolver, publicURL string, log *slog.Logger) http.Handler {
	impl := &sdk.Implementation{Name: "texera-catalog", Title: "Texera catalog MCP server", Version: "2.0.0-alpha"}
	srv := sdk.NewServer(impl, &sdk.ServerOptions{Instructions: instructions})
	for _, t := range Tools {
		t := t
		tool := &sdk.Tool{Name: t.Name, Description: t.Description, InputSchema: json.RawMessage(t.Input), Annotations: &sdk.ToolAnnotations{ReadOnlyHint: t.ReadOnly, IdempotentHint: t.Idempotent, DestructiveHint: t.Destructive}}
		srv.AddTool(tool, func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
			return bridge(ctx, api, t, req)
		})
	}
	h := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return srv }, &sdk.StreamableHTTPOptions{Stateless: true, Logger: log})
	verify := func(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
		caller, err := resolver.FromToken(ctx, token)
		if err != nil {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{Scopes: []string{"texera"}, Expiration: time.Now().Add(time.Hour), UserID: caller.PID().String(), Extra: map[string]any{"token": token}}, nil
	}
	return auth.RequireBearerToken(verify, &auth.RequireBearerTokenOptions{ResourceMetadataURL: strings.TrimSuffix(publicURL, "/") + "/.well-known/oauth-protected-resource"})(h)
}

// instructions is what the server tells a client about itself: every tool, by what it is for.
const instructions = `The Texera catalog: every resource and what can be done with it. A resource (a workflow, dataset,
execution, skill, MCP server, computing unit, profile, warehouse, operator, conversation,
credential or model endpoint) has a texera:// URI, versions, grants and lineage. whoami says who is calling.
Every resource lives in a project, and a project inherits from its base, up to Texera, which every
project inherits from: its people read and use what the projects up its chain hold, and
project_settings says what its work runs with (its default agent, model, unit, profile and
warehouse, its look and its limits) and which project of the chain each comes from.
search_resources finds things by kind, project or text; resolve_uri and get_resource read one;
list_versions and get_version read history; get_lineage shows where a version came from and what
was made from it; grant_access shares a resource with a principal found by search_principals.
Datasets are versioned files: list_dataset_files and read_dataset_file look at a version,
create_dataset makes a dataset, import_dataset_file brings a file in from a public https URL
(the catalog fetches it), commit_dataset_version makes a version of what is staged, and keep_attachment
makes a file attached to a chat one of the project's datasets. list_operators, with q, gives an operator's property schema
and ports; list_computing_units the units the caller may run on. A profile is what a unit's node
is made of, its size and the Python packages it adds: create_computing_unit makes a unit from a
profile (search_resources with kind profile lists them; waitSeconds waits until it is ready, and
a run on a unit that is not is refused), and save_unit_as_profile saves a unit, its packages
pinned as installed, as the next version of a profile or a new one.
A workflow is a dataflow graph of operators that runs on a computing unit and keeps its results
in a warehouse; every edit is a version, and running it makes an execution with lineage. create_workflow takes a spec {operators,
links} where a scan's fileName is texera://datasets/<rid>@<vno>/files/<path>; get_workflow reads
it; edit_workflow applies an RFC 6902 patch as a new version; validate_workflow compiles it,
until it reports ok; run_workflow with waitSeconds starts an execution (on the computing unit and
in the warehouse it names, else the workflow's, else the project's default; upTo
runs only what leads to one operator) and
get_port_result reads its rows: results live with the execution. get_execution follows one that is still going;
pause_execution and resume_execution hold and continue it.`

// maxToolTextBytes bounds what a tool returns to a model.
const maxToolTextBytes = 256 << 10

// serve answers a tool call's request in process. net/http ends only the request when a handler
// panics; this runs on the MCP connection's own goroutine, where a panic would end the catalog.
func serve(api http.Handler, rec *httptest.ResponseRecorder, r *http.Request, tool string) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("a tool call panicked", "tool", tool, "panic", p, "stack", string(debug.Stack()))
			rec.Code = http.StatusInternalServerError
			rec.Body.Reset()
			rec.Body.WriteString(`{"code":"internal","message":"the catalog failed on this call"}`)
		}
	}()
	api.ServeHTTP(rec, r)
}

// bridge turns a tool call into the operation's HTTP request against the API handler.
func bridge(ctx context.Context, api http.Handler, t Tool, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
	args := map[string]any{}
	if raw := req.Params.Arguments; len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return toolError("arguments must be a JSON object: " + err.Error()), nil
		}
	}
	path := t.Path
	for _, p := range t.PathParams {
		v, ok := args[p.Name]
		if !ok || fmt.Sprint(v) == "" {
			return toolError("missing argument " + p.Name), nil
		}
		path = strings.ReplaceAll(path, "{"+p.Name+"}", url.PathEscape(fmt.Sprint(v)))
		delete(args, p.Name)
	}
	query := url.Values{}
	for _, p := range t.QueryParams {
		if v, ok := args[p.Name]; ok && v != nil {
			query.Set(p.Name, fmt.Sprint(v))
			delete(args, p.Name)
		}
	}
	var body io.Reader
	if t.Body {
		raw, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(raw)
	}
	target := path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	hr, err := http.NewRequestWithContext(ctx, t.Method, target, body)
	if err != nil {
		return nil, err
	}
	if t.Body {
		hr.Header.Set("Content-Type", "application/json")
	}
	if req.Extra != nil {
		if req.Extra.TokenInfo != nil {
			if token, ok := req.Extra.TokenInfo.Extra["token"].(string); ok {
				hr.Header.Set("Authorization", "Bearer "+token)
			}
		}
		if req.Extra.Header != nil {
			for _, h := range []string{"X-Texera-Origin", "X-Texera-Service-Token"} {
				if v := req.Extra.Header.Get(h); v != "" {
					hr.Header.Set(h, v)
				}
			}
		}
	}
	rec := httptest.NewRecorder()
	serve(api, rec, hr, t.Name)
	data := rec.Body.Bytes()
	if rec.Code >= 400 {
		return toolError(fmt.Sprintf("%d: %s", rec.Code, truncate(data))), nil
	}
	if rec.Code == http.StatusNoContent || len(bytes.TrimSpace(data)) == 0 {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: `{"ok":true}`}}, StructuredContent: map[string]any{"ok": true}}, nil
	}
	var structured any
	isJSON := strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") && json.Unmarshal(data, &structured) == nil
	if isJSON {
		// Where a workflow's operators sit is the app's; the agent reads what runs.
		if withoutPlaces(structured) {
			data, _ = json.Marshal(structured)
		}
	}
	text := truncate(data)
	result := &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}
	if isJSON {
		if obj, ok := structured.(map[string]any); ok {
			result.StructuredContent = obj
		} else {
			result.StructuredContent = map[string]any{"items": structured}
		}
	}
	return result, nil
}

// withoutPlaces takes out of a tool's answer where the operators of every workflow spec in it
// sit (a spec is an object with operators and links); it says whether there was any.
func withoutPlaces(v any) bool {
	taken := false
	switch t := v.(type) {
	case map[string]any:
		if _, ops := t["operators"]; ops {
			if _, links := t["links"]; links {
				if _, ok := t["layout"]; ok {
					delete(t, "layout")
					taken = true
				}
			}
		}
		for _, child := range t {
			taken = withoutPlaces(child) || taken
		}
	case []any:
		for _, child := range t {
			taken = withoutPlaces(child) || taken
		}
	}
	return taken
}

func toolError(msg string) *sdk.CallToolResult {
	return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: msg}}}
}

func truncate(data []byte) string {
	if len(data) <= maxToolTextBytes {
		return string(data)
	}
	return string(data[:maxToolTextBytes]) + "\n... (truncated)"
}
