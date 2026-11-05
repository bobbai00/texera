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

// Handler serves one MCP server (catalog or dataflow) over streamable HTTP. A tool call
// becomes the HTTP request of its operation, answered by the catalog's API handler in process
// with the caller's own bearer token, so the tools and the REST API cannot disagree.
func Handler(server string, api http.Handler, resolver *texauth.Resolver, publicURL string, log *slog.Logger) http.Handler {
	impl := &sdk.Implementation{Name: "texera-" + server, Title: "Texera " + server + " MCP server", Version: "2.0.0-alpha"}
	srv := sdk.NewServer(impl, &sdk.ServerOptions{Instructions: instructions[server]})
	for _, t := range ForServer(server) {
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

var instructions = map[string]string{
	"catalog": `The Texera catalog: what exists. Every resource (workflows, datasets, executions, skills, MCP
servers, computing units, environments, operators, conversations, credentials, model endpoints)
has a texera:// URI, versions, grants and lineage. search_resources finds things by kind, project
or text; resolve_uri and get_resource read one; list_versions and get_version read history;
get_lineage shows where a version came from and what was made from it; grant_access shares a
resource with a principal found by search_principals. Datasets are versioned files:
list_dataset_files and read_dataset_file look at a version, commit_dataset_version makes one.
list_operators, with q, gives an operator's property schema and ports; list_computing_units the
units the caller may run on. Building and running workflows is the dataflow server's.`,
	"dataflow": `Texera workflows are dataflow graphs of operators that run on computing units; every edit is
a version and every run is an execution with lineage. This server holds the verbs of a workflow
and its runs, and nothing else: create_workflow with a spec {operators, links} where a scan's
fileName is texera://datasets/<rid>@<vno>/files/<path>, get_workflow to read it, edit_workflow
to apply an RFC 6902 patch as a new version, validate_workflow until it reports ok, run_workflow
with waitSeconds, then get_port_result for rows; results live with the run. get_execution
follows a run that is still going; pause_execution and resume_execution hold and continue it.
The data, the operators' schemas and the computing units are found through the catalog server.`,
}

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
