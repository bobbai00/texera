// Command catalogen generates the catalog's tables from the OpenAPI document that TypeSpec
// emits. TypeSpec is the only hand-written description of the API; everything here is
// derived from it and committed, and `make check-drift` fails when the two disagree.
//
// Inputs: the OpenAPI 3.1 document and the three extensions the contract carries:
//
//	x-texera-kind        on an envelope schema: kind, plural, versioned, content, parent,
//	                     nested, singleton, index
//	x-texera-permission  on every operation: the permission the caller needs
//	x-mcp                on an operation: the MCP tool it is exposed as, and on which server
//
// Outputs, relative to the repository root:
//
//	catalog/internal/kinds/kinds.gen.go               the kind table
//	catalog/internal/kinds/schema.gen.json            the JSON Schema bundle ($defs) of every model
//	catalog/internal/mcp/tools.gen.go                 the MCP tool table, one per x-mcp operation
//	catalog/internal/authz/permissions.gen.go         method+path -> permission
//	catalog/internal/store/migrations/0002_indexes.gen.sql   expression indexes for x-texera-kind.index
//	packages/kinds/src/kinds.gen.ts                   the kind table for the app
//	packages/kinds/src/schema.gen.json                the same bundle for the app
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

type kind struct {
	Name      string
	Plural    string
	Versioned bool
	Content   string
	Parent    string
	Nested    bool
	Singleton bool
	Index     []string
	Envelope  string
	Spec      string
	Status    string
}

type param struct {
	Name        string
	Type        string
	Required    bool
	Description string
	Enum        []any
}

type tool struct {
	Server      string
	Name        string
	Description string
	ReadOnly    bool
	Idempotent  bool
	Destructive *bool
	Method      string
	Path        string
	PathParams  []param
	QueryParams []param
	Body        bool
	Input       string
}

func main() {
	spec := flag.String("spec", "", "the OpenAPI 3.1 document")
	root := flag.String("root", "", "the repository root")
	flag.Parse()
	if *spec == "" || *root == "" {
		fmt.Fprintln(os.Stderr, "usage: catalogen -spec openapi.yaml -root <repo root>")
		os.Exit(2)
	}
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(*spec)
	if err != nil {
		fail(err)
	}
	defs, err := schemaDefs(doc)
	if err != nil {
		fail(err)
	}
	kinds, err := collectKinds(doc)
	if err != nil {
		fail(err)
	}
	tools, err := collectTools(doc, defs)
	if err != nil {
		fail(err)
	}
	perms, err := collectPermissions(doc)
	if err != nil {
		fail(err)
	}
	bundle, err := json.MarshalIndent(map[string]any{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"$id":     "https://texera.apache.org/schemas/catalog.json",
		"$defs":   defs,
	}, "", "  ")
	if err != nil {
		fail(err)
	}
	bundle = append(bundle, '\n')

	outputs := map[string][]byte{
		"catalog/internal/kinds/kinds.gen.go":                    mustFormat(renderKindsGo(kinds)),
		"catalog/internal/kinds/schema.gen.json":                 bundle,
		"catalog/internal/mcp/tools.gen.go":                      mustFormat(renderToolsGo(tools)),
		"catalog/internal/authz/permissions.gen.go":              mustFormat(renderPermissionsGo(perms)),
		"catalog/internal/store/migrations/0002_indexes.gen.sql": renderIndexesSQL(kinds),
		"packages/kinds/src/kinds.gen.ts":                        renderKindsTS(kinds),
		"packages/kinds/src/schema.gen.json":                     bundle,
	}
	for rel, body := range outputs {
		path := filepath.Join(*root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			fail(err)
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			fail(err)
		}
	}
	fmt.Printf("catalogen: %d kinds, %d tools, %d operations\n", len(kinds), len(tools), len(perms))
}

// schemaDefs returns every component schema as a JSON Schema object, with references
// rewritten from #/components/schemas/X to #/$defs/X.
func schemaDefs(doc *openapi3.T) (map[string]any, error) {
	raw, err := json.Marshal(doc.Components.Schemas)
	if err != nil {
		return nil, err
	}
	var defs map[string]any
	if err := json.Unmarshal(raw, &defs); err != nil {
		return nil, err
	}
	rewriteRefs(defs)
	return defs, nil
}

func rewriteRefs(v any) {
	switch x := v.(type) {
	case map[string]any:
		if ref, ok := x["$ref"].(string); ok {
			x["$ref"] = strings.Replace(ref, "#/components/schemas/", "#/$defs/", 1)
		}
		for _, child := range x {
			rewriteRefs(child)
		}
	case []any:
		for _, child := range x {
			rewriteRefs(child)
		}
	}
}

func collectKinds(doc *openapi3.T) ([]kind, error) {
	var kinds []kind
	for name, ref := range doc.Components.Schemas {
		if ref == nil || ref.Value == nil {
			continue
		}
		raw, ok := ref.Value.Extensions["x-texera-kind"]
		if !ok {
			continue
		}
		ext, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s: x-texera-kind must be an object", name)
		}
		k := kind{
			Name:      str(ext["kind"]),
			Plural:    str(ext["plural"]),
			Versioned: boolean(ext["versioned"]),
			Content:   str(ext["content"]),
			Parent:    str(ext["parent"]),
			Nested:    boolean(ext["nested"]),
			Singleton: boolean(ext["singleton"]),
			Envelope:  name,
		}
		if list, ok := ext["index"].([]any); ok {
			for _, item := range list {
				k.Index = append(k.Index, str(item))
			}
		}
		if k.Name == "" || k.Plural == "" || k.Content == "" {
			return nil, fmt.Errorf("%s: x-texera-kind needs kind, plural and content", name)
		}
		if p := ref.Value.Properties["spec"]; p != nil {
			k.Spec = refName(p.Ref)
		}
		if p := ref.Value.Properties["status"]; p != nil {
			k.Status = refName(p.Ref)
		}
		if k.Spec == "" {
			return nil, fmt.Errorf("%s: the spec must be a named model", name)
		}
		kinds = append(kinds, k)
	}
	sort.Slice(kinds, func(i, j int) bool { return kinds[i].Name < kinds[j].Name })
	return kinds, nil
}

func collectTools(doc *openapi3.T, defs map[string]any) ([]tool, error) {
	var tools []tool
	seen := map[string]string{}
	for _, path := range sortedPaths(doc) {
		item := doc.Paths.Find(path)
		for method, op := range item.Operations() {
			raw, ok := op.Extensions["x-mcp"]
			if !ok {
				continue
			}
			ext, ok := raw.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s %s: x-mcp must be an object", method, path)
			}
			t := tool{
				Server:      str(ext["server"]),
				Name:        str(ext["tool"]),
				Description: str(ext["description"]),
				Method:      method,
				Path:        path,
			}
			if t.Server == "" || t.Name == "" {
				return nil, fmt.Errorf("%s %s: x-mcp needs server and tool", method, path)
			}
			if prev, dup := seen[t.Name]; dup {
				return nil, fmt.Errorf("tool %s defined twice: %s and %s %s", t.Name, prev, method, path)
			}
			seen[t.Name] = method + " " + path
			if v, ok := ext["readOnlyHint"].(bool); ok {
				t.ReadOnly = v
			}
			if v, ok := ext["destructiveHint"].(bool); ok {
				t.Destructive = &v
			}
			if v, ok := ext["idempotentHint"].(bool); ok {
				t.Idempotent = v
			}
			for _, pref := range op.Parameters {
				p := pref.Value
				gp := param{Name: p.Name, Type: schemaType(p.Schema), Required: p.Required, Description: p.Description}
				if p.Schema != nil && p.Schema.Value != nil {
					gp.Enum = p.Schema.Value.Enum
				}
				switch p.In {
				case "path":
					t.PathParams = append(t.PathParams, gp)
				case "query":
					t.QueryParams = append(t.QueryParams, gp)
				}
			}
			// Path parameters in the order the template names them.
			sort.SliceStable(t.PathParams, func(i, j int) bool {
				return strings.Index(path, "{"+t.PathParams[i].Name+"}") < strings.Index(path, "{"+t.PathParams[j].Name+"}")
			})
			var bodyName string
			if op.RequestBody != nil && op.RequestBody.Value != nil {
				if mt := op.RequestBody.Value.Content.Get("application/json"); mt != nil && mt.Schema != nil {
					t.Body = true
					bodyName = refName(mt.Schema.Ref)
					if bodyName == "" {
						return nil, fmt.Errorf("%s %s: a tool's body must be a named model", method, path)
					}
				}
			}
			input, err := toolInput(t, bodyName, defs)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", t.Name, err)
			}
			t.Input = input
			tools = append(tools, t)
		}
	}
	sort.Slice(tools, func(i, j int) bool {
		if tools[i].Server != tools[j].Server {
			return tools[i].Server < tools[j].Server
		}
		return tools[i].Name < tools[j].Name
	})
	return tools, nil
}

// toolInput builds the tool's input schema: the path and query parameters and the body's
// properties as one flat object, with the definitions the body reaches under $defs.
func toolInput(t tool, bodyName string, defs map[string]any) (string, error) {
	props := map[string]any{}
	var required []string
	for _, p := range append(append([]param{}, t.PathParams...), t.QueryParams...) {
		schema := map[string]any{"type": p.Type}
		if p.Description != "" {
			schema["description"] = p.Description
		}
		if len(p.Enum) > 0 {
			schema["enum"] = p.Enum
		}
		props[p.Name] = schema
		if p.Required {
			required = append(required, p.Name)
		}
	}
	needed := map[string]any{}
	if bodyName != "" {
		body, ok := defs[bodyName].(map[string]any)
		if !ok {
			return "", fmt.Errorf("body model %s not found", bodyName)
		}
		bodyProps, _ := body["properties"].(map[string]any)
		for name, schema := range bodyProps {
			if _, taken := props[name]; taken {
				return "", fmt.Errorf("body field %s collides with a parameter", name)
			}
			props[name] = schema
			collectRefs(schema, defs, needed)
		}
		if req, ok := body["required"].([]any); ok {
			for _, r := range req {
				required = append(required, str(r))
			}
		}
	}
	sort.Strings(required)
	schema := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	if len(needed) > 0 {
		schema["$defs"] = needed
	}
	out, err := json.Marshal(schema)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// collectRefs adds to needed every definition reachable from v through $ref.
func collectRefs(v any, defs map[string]any, needed map[string]any) {
	switch x := v.(type) {
	case map[string]any:
		if ref, ok := x["$ref"].(string); ok && strings.HasPrefix(ref, "#/$defs/") {
			name := strings.TrimPrefix(ref, "#/$defs/")
			if _, done := needed[name]; !done {
				if def, ok := defs[name]; ok {
					needed[name] = def
					collectRefs(def, defs, needed)
				}
			}
		}
		for _, child := range x {
			collectRefs(child, defs, needed)
		}
	case []any:
		for _, child := range x {
			collectRefs(child, defs, needed)
		}
	}
}

func collectPermissions(doc *openapi3.T) (map[string]string, error) {
	perms := map[string]string{}
	for _, path := range sortedPaths(doc) {
		item := doc.Paths.Find(path)
		for method, op := range item.Operations() {
			perm, _ := op.Extensions["x-texera-permission"].(string)
			if perm == "" {
				return nil, fmt.Errorf("%s %s (%s): missing x-texera-permission", method, path, op.OperationID)
			}
			perms[method+" "+path] = perm
		}
	}
	return perms, nil
}

func renderKindsGo(kinds []kind) []byte {
	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/catalogen from the OpenAPI document. DO NOT EDIT.\n\npackage kinds\n\n")
	b.WriteString("// Table lists every kind of the contract, in kind order.\nvar Table = []Kind{\n")
	for _, k := range kinds {
		fmt.Fprintf(&b, "\t{Name: %q, Plural: %q, Versioned: %v, Content: %q, Parent: %q, Nested: %v, Singleton: %v, Index: %s, Envelope: %q, Spec: %q, Status: %q},\n",
			k.Name, k.Plural, k.Versioned, k.Content, k.Parent, k.Nested, k.Singleton, goStrings(k.Index), k.Envelope, k.Spec, k.Status)
	}
	b.WriteString("}\n")
	return b.Bytes()
}

func renderToolsGo(tools []tool) []byte {
	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/catalogen from the OpenAPI document. DO NOT EDIT.\n\npackage mcp\n\n")
	b.WriteString("// Tools lists every x-mcp operation as a tool, by server then name.\nvar Tools = []Tool{\n")
	for _, t := range tools {
		fmt.Fprintf(&b, "\t{\n\t\tServer: %q, Name: %q,\n\t\tDescription: %q,\n\t\tReadOnly: %v, Idempotent: %v, Destructive: %s,\n\t\tMethod: %q, Path: %q,\n\t\tPathParams: %s, QueryParams: %s, Body: %v,\n\t\tInput: %s,\n\t},\n",
			t.Server, t.Name, t.Description, t.ReadOnly, t.Idempotent, goBoolPtr(t.Destructive), t.Method, t.Path, goParams(t.PathParams), goParams(t.QueryParams), t.Body, strconv.Quote(t.Input))
	}
	b.WriteString("}\n")
	return b.Bytes()
}

func renderPermissionsGo(perms map[string]string) []byte {
	keys := make([]string, 0, len(perms))
	for k := range perms {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/catalogen from the OpenAPI document. DO NOT EDIT.\n\npackage authz\n\n")
	b.WriteString("// Permissions maps every operation, as \"METHOD /path/template\", to the permission the\n// caller needs (x-texera-permission).\nvar Permissions = map[string]string{\n")
	for _, k := range keys {
		fmt.Fprintf(&b, "\t%q: %q,\n", k, perms[k])
	}
	b.WriteString("}\n")
	return b.Bytes()
}

func renderIndexesSQL(kinds []kind) []byte {
	var b bytes.Buffer
	b.WriteString("-- Code generated by cmd/catalogen from the OpenAPI document (x-texera-kind.index). DO NOT EDIT.\n")
	b.WriteString("-- One expression index per declared spec or status field a list filters on.\n")
	for _, k := range kinds {
		for _, pointer := range k.Index {
			parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
			if len(parts) < 2 || (parts[0] != "spec" && parts[0] != "status") {
				continue
			}
			name := "resource_" + strings.ReplaceAll(k.Name, "-", "_") + "_" + strings.Join(parts, "_") + "_idx"
			fmt.Fprintf(&b, "CREATE INDEX IF NOT EXISTS %s ON resource ((%s #>> '{%s}')) WHERE kind = '%s' AND deleted_at IS NULL;\n",
				name, parts[0], strings.Join(parts[1:], ","), k.Name)
		}
	}
	return b.Bytes()
}

func renderKindsTS(kinds []kind) []byte {
	var b bytes.Buffer
	b.WriteString("// Code generated by cmd/catalogen from the OpenAPI document. DO NOT EDIT.\n\n")
	b.WriteString("/** One kind of the contract, as x-texera-kind declares it. */\nexport interface KindEntry {\n  kind: string;\n  plural: string;\n  versioned: boolean;\n  content: \"spec\" | \"manifest\" | \"table\";\n  parent?: string;\n  nested: boolean;\n  singleton: boolean;\n  envelope: string;\n  spec: string;\n  status?: string;\n}\n\n")
	b.WriteString("/** Every kind, in kind order. */\nexport const KIND_TABLE: readonly KindEntry[] = [\n")
	for _, k := range kinds {
		fmt.Fprintf(&b, "  { kind: %q, plural: %q, versioned: %v, content: %q", k.Name, k.Plural, k.Versioned, k.Content)
		if k.Parent != "" {
			fmt.Fprintf(&b, ", parent: %q", k.Parent)
		}
		fmt.Fprintf(&b, ", nested: %v, singleton: %v, envelope: %q, spec: %q", k.Nested, k.Singleton, k.Envelope, k.Spec)
		if k.Status != "" {
			fmt.Fprintf(&b, ", status: %q", k.Status)
		}
		b.WriteString(" },\n")
	}
	b.WriteString("];\n")
	return b.Bytes()
}

func goStrings(items []string) string {
	if len(items) == 0 {
		return "nil"
	}
	quoted := make([]string, len(items))
	for i, s := range items {
		quoted[i] = strconv.Quote(s)
	}
	return "[]string{" + strings.Join(quoted, ", ") + "}"
}

func goParams(params []param) string {
	if len(params) == 0 {
		return "nil"
	}
	var parts []string
	for _, p := range params {
		parts = append(parts, fmt.Sprintf("{Name: %q, Type: %q, Required: %v}", p.Name, p.Type, p.Required))
	}
	return "[]Param{" + strings.Join(parts, ", ") + "}"
}

func goBoolPtr(b *bool) string {
	if b == nil {
		return "nil"
	}
	return fmt.Sprintf("boolPtr(%v)", *b)
}

func mustFormat(src []byte) []byte {
	out, err := format.Source(src)
	if err != nil {
		fail(fmt.Errorf("format: %w\n%s", err, src))
	}
	return out
}

func sortedPaths(doc *openapi3.T) []string {
	var out []string
	for p := range doc.Paths.Map() {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func schemaType(ref *openapi3.SchemaRef) string {
	if ref == nil || ref.Value == nil || ref.Value.Type == nil {
		return "string"
	}
	for _, t := range ref.Value.Type.Slice() {
		switch t {
		case "integer", "number", "boolean", "string":
			return t
		}
	}
	return "string"
}

func refName(ref string) string {
	if ref == "" {
		return ""
	}
	return ref[strings.LastIndex(ref, "/")+1:]
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func boolean(v any) bool {
	b, _ := v.(bool)
	return b
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "catalogen:", err)
	os.Exit(1)
}
