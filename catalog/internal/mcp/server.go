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
execution, skill, MCP server, computing unit, warehouse, environment, operator, conversation,
credential or model endpoint) has a texera:// URI, versions, grants and lineage. whoami says who is calling.
search_resources finds things by kind, project or text; resolve_uri and get_resource read one;
list_versions and get_version read history; get_lineage shows where a version came from and what
was made from it; grant_access shares a resource with a principal found by search_principals.
Datasets are versioned files: list_dataset_files and read_dataset_file look at a version,
commit_dataset_version makes one. list_operators, with q, gives an operator's property schema
and ports; list_computing_units the units the caller may run on.
A workflow is a dataflow graph of operators that runs on a computing unit and keeps its results
in a warehouse; every edit is a version, and running it makes an execution with lineage. create_workflow takes a spec {operators,
links} where a scan's fileName is texera://datasets/<rid>@<vno>/files/<path>; get_workflow reads
it; edit_workflow applies an RFC 6902 patch as a new version; validate_workflow compiles it,
until it reports ok; run_workflow with waitSeconds starts an execution and get_port_result reads
its rows: results live with the execution. get_execution follows one that is still going;
pause_execution and resume_execution hold and continue it.`

// maxToolTextBytes bounds what a tool returns to a model.
const maxToolTextBytes = 256 << 10

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
	api.ServeHTTP(rec, hr)
	data := rec.Body.Bytes()
	if rec.Code >= 400 {
		return toolError(fmt.Sprintf("%d: %s", rec.Code, truncate(data))), nil
	}
	if rec.Code == http.StatusNoContent || len(bytes.TrimSpace(data)) == 0 {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: `{"ok":true}`}}, StructuredContent: map[string]any{"ok": true}}, nil
	}
	text := truncate(data)
	result := &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		var structured any
		if err := json.Unmarshal(data, &structured); err == nil {
			if obj, ok := structured.(map[string]any); ok {
				result.StructuredContent = obj
			} else {
				result.StructuredContent = map[string]any{"items": structured}
			}
		}
	}
	return result, nil
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
