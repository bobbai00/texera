package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func call(t *testing.T, api http.HandlerFunc, tool Tool, arguments map[string]any) *sdk.CallToolResult {
	t.Helper()
	raw, err := json.Marshal(arguments)
	if err != nil {
		t.Fatal(err)
	}
	result, err := bridge(context.Background(), api, tool, &sdk.CallToolRequest{Params: &sdk.CallToolParamsRaw{Name: tool.Name, Arguments: raw}})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func text(t *testing.T, result *sdk.CallToolResult) string {
	t.Helper()
	var out []string
	for _, c := range result.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			out = append(out, tc.Text)
		}
	}
	return strings.Join(out, "\n")
}

var getRows = Tool{Name: "get_port_result", Method: "GET", Path: "/rows/{rid}", PathParams: []Param{{Name: "rid", Type: "string", Required: true}}}

// What the API refused is what the tool says: the status and the words, flagged as an error, so
// an agent reads the engine's reason and can act on it.
func TestAToolReportsTheErrorOfItsOperationInItsOwnWords(t *testing.T) {
	cases := []struct {
		status int
		body   string
	}{
		{http.StatusNotFound, `{"code":"not_found","message":"no result for nosuch/output-0"}`},
		{http.StatusBadGateway, `{"code":"unit_error","message":"unit: the table is corrupt"}`},
		{http.StatusConflict, `{"code":"running","message":"execution 1 of this workflow is still running"}`},
	}
	for _, tc := range cases {
		api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		})
		result := call(t, api, getRows, map[string]any{"rid": "r1"})
		if !result.IsError {
			t.Fatalf("%d: want an error result", tc.status)
		}
		got := text(t, result)
		var body struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal([]byte(tc.body), &body); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got, body.Message) || !strings.HasPrefix(got, strconv.Itoa(tc.status)+": ") {
			t.Fatalf("%d: %q", tc.status, got)
		}
	}
}

func TestAToolWithoutARequiredArgumentSaysWhich(t *testing.T) {
	api := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("no request without its argument") })
	result := call(t, api, getRows, map[string]any{})
	if !result.IsError || !strings.Contains(text(t, result), "missing argument rid") {
		t.Fatalf("%+v", result)
	}
}

func TestASuccessIsNotAnError(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"rows":[]}`))
	})
	result := call(t, api, getRows, map[string]any{"rid": "r1"})
	if result.IsError || text(t, result) != `{"rows":[]}` {
		t.Fatalf("%+v", result)
	}
}

func TestAToolResultIsBounded(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", maxToolTextBytes+10)))
	})
	got := text(t, call(t, api, getRows, map[string]any{"rid": "r1"}))
	if !strings.HasSuffix(got, "(truncated)") || len(got) > maxToolTextBytes+64 {
		t.Fatalf("%d bytes", len(got))
	}
}
