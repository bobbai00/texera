// Package mcp serves the Texera MCP server: the catalog's x-mcp operations as tools, called
// in process through the strict server interface, behind the same bearer authentication as
// the REST API. The tool table is generated (tools.gen.go).
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
)

// Resolver resolves the caller behind an HTTP request.
type Resolver interface {
	Resolve(ctx context.Context, r *http.Request) (*authn.Caller, error)
}

// Handler builds the Streamable HTTP MCP handler. publicURL is the gateway URL used for the
// protected-resource metadata pointer in 401 answers.
func Handler(impl api.StrictServerInterface, resolver Resolver, publicURL string, log *slog.Logger) http.Handler {
	server := sdk.NewServer(&sdk.Implementation{Name: "texera", Title: "Texera dataflow MCP server", Version: "2.0.0-alpha"},
		&sdk.ServerOptions{Instructions: instructions})
	registerTools(server, impl, wrapContext, finish)
	h := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, &sdk.StreamableHTTPOptions{Stateless: true, Logger: log})
	verify := func(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
		caller, err := resolver.Resolve(ctx, r)
		if err != nil {
			return nil, auth.ErrInvalidToken
		}
		return &auth.TokenInfo{
			Scopes:     []string{"texera"},
			Expiration: time.Now().Add(time.Hour),
			UserID:     caller.Principal.PID.String(),
			Extra:      map[string]any{"caller": caller},
		}, nil
	}
	return auth.RequireBearerToken(verify, &auth.RequireBearerTokenOptions{ResourceMetadataURL: strings.TrimSuffix(publicURL, "/") + "/.well-known/oauth-protected-resource"})(h)
}

const instructions = `Texera is a collaborative data science workspace. Workflows are dataflow graphs of operators
that run on computing units; datasets are versioned files; every change creates a version and
every run is an execution with lineage. Typical flow: search_resources and list_dataset_files to
find data (read_dataset_file shows a CSV header), list_operators to learn operator types and
their property schemas, create_workflow with content {operators, links} where a scan's fileName is
a dataset://<rid>@<vno>/<path> URI, validate_workflow until it reports ok, run_workflow with
waitSeconds, then get_port_result for rows. edit_workflow applies an RFC 6902 patch and makes a
new version.`

// wrapContext puts the caller resolved by the bearer middleware into the context the strict
// handlers read it from.
func wrapContext(ctx context.Context, req *sdk.CallToolRequest) (context.Context, error) {
	if c := authn.CallerFrom(ctx); c != nil {
		return ctx, nil
	}
	if req != nil && req.Extra != nil && req.Extra.TokenInfo != nil {
		if caller, ok := req.Extra.TokenInfo.Extra["caller"].(*authn.Caller); ok {
			return authn.WithCaller(ctx, caller), nil
		}
	}
	return ctx, fmt.Errorf("unauthenticated")
}

// finish renders a strict response object (any *200JSONResponse or 204 marker) as the tool
// result: JSON text for the model and structured content for clients. Errors become tool
// errors so the model can react.
func finish(resp any, err error) (*sdk.CallToolResult, map[string]any, error) {
	if err != nil {
		msg := err.Error()
		return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: msg}}}, nil, nil
	}
	if text, ok := readerBody(resp); ok {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, map[string]any{"text": text}, nil
	}
	body := map[string]any{}
	if resp == nil || isEmptyStruct(resp) {
		body["ok"] = true
	} else {
		raw, err := json.Marshal(resp)
		if err != nil {
			return nil, nil, err
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			// Non-object responses (arrays) are wrapped.
			var v any
			_ = json.Unmarshal(raw, &v)
			body = map[string]any{"items": v}
		}
	}
	text, _ := json.Marshal(body)
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(text)}}}, body, nil
}

// maxToolTextBytes bounds binary bodies (file reads) returned to a model.
const maxToolTextBytes = 64 << 10

// readerBody returns the text of a streamed response (a struct with a Body io.Reader field),
// bounded, for responses such as file downloads.
func readerBody(v any) (string, bool) {
	rv := reflect.ValueOf(v)
	if !rv.IsValid() || rv.Kind() != reflect.Struct {
		return "", false
	}
	f := rv.FieldByName("Body")
	if !f.IsValid() || f.IsNil() {
		return "", false
	}
	r, ok := f.Interface().(io.Reader)
	if !ok {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(r, maxToolTextBytes))
	if c, ok := r.(io.Closer); ok {
		_ = c.Close()
	}
	if err != nil {
		return "", false
	}
	return string(data), true
}

func isEmptyStruct(v any) bool {
	t := reflect.TypeOf(v)
	return t != nil && t.Kind() == reflect.Struct && t.NumField() == 0
}
