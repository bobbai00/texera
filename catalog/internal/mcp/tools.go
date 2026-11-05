// Package mcp serves the catalog's MCP server. Every operation the contract tags x-mcp is a
// tool (tools.gen.go); a tool call is turned into the HTTP request of its operation and
// answered by the catalog's own handler in process, so the REST API and the tools cannot
// disagree. There is one server because there is one catalog: a workflow is a resource and
// running it is one of its verbs.
package mcp

// Param is a path or query parameter of a tool's operation.
type Param struct {
	Name     string
	Type     string
	Required bool
}

// Tool is one x-mcp operation.
type Tool struct {
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
