// Package mcp serves the catalog's MCP servers. Every operation the contract tags x-mcp is a
// tool (tools.gen.go); a tool call is turned into the HTTP request of its operation and
// answered by the catalog's own handler in process, so the REST API and the tools cannot
// disagree. Two servers share one table and no tool: `dataflow` holds the verbs of a workflow and
// its runs (build, edit, compile, run, control, read results), `catalog` everything else (any
// resource with its versions, grants and lineage, dataset files, operators, computing units,
// people). The rule is the operation's path: under /workflows it is a dataflow tool.
package mcp

// Param is a path or query parameter of a tool's operation.
type Param struct {
	Name     string
	Type     string
	Required bool
}

// Tool is one x-mcp operation.
type Tool struct {
	// Server is the MCP server the tool belongs to: catalog or dataflow.
	Server      string
	Name        string
	Description string
	ReadOnly    bool
	Idempotent  bool
	Destructive *bool
	// Method and Path are the operation; Path is the OpenAPI template with {param} segments.
	Method string
	Path   string
	// PathParams and QueryParams are read from the tool's arguments; Body says whether the
	// remaining arguments form the JSON body.
	PathParams  []Param
	QueryParams []Param
	Body        bool
	// Input is the tool's input JSON Schema.
	Input string
}

func boolPtr(b bool) *bool { return &b }

// ForServer returns the tools of one server.
func ForServer(server string) []Tool {
	var out []Tool
	for _, t := range Tools {
		if t.Server == server {
			out = append(out, t)
		}
	}
	return out
}
