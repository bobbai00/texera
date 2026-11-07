// Package kinds is the generated registry of the contract's kinds: the table every generic
// piece of the catalog reads (routes, the store, the URI grammar, the reference extractor)
// and the JSON Schema bundle that validates every spec and status.
package kinds

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Kind describes one kind, as x-texera-kind declares it.
type Kind struct {
	// Name is the singular kebab-case kind, e.g. "computing-unit".
	Name string
	// Plural is the collection, e.g. "computing-units".
	Plural string
	// Versioned kinds snapshot their content on every write.
	Versioned bool
	// Content is what a version holds: spec, manifest or table.
	Content string
	// Parent is the kind of the parent, "" for a project.
	Parent string
	// Nested kinds live under their parent's path, e.g. workflows/{rid}/executions/{eid}.
	Nested bool
	// Index lists the spec or status fields, as JSON pointers, a list filters on.
	Index []string
	// Envelope, Spec and Status are the schema names in the bundle.
	Envelope string
	Spec     string
	Status   string
}

//go:embed schema.gen.json
var schemaBundle []byte

var (
	byName   = map[string]Kind{}
	byPlural = map[string]Kind{}
)

func init() {
	for _, k := range Table {
		byName[k.Name] = k
		byPlural[k.Plural] = k
	}
}

// ByName returns the kind with the given singular name.
func ByName(name string) (Kind, bool) {
	k, ok := byName[name]
	return k, ok
}

// ByPlural returns the kind with the given collection name.
func ByPlural(plural string) (Kind, bool) {
	k, ok := byPlural[plural]
	return k, ok
}

// Names returns every kind name, in table order.
func Names() []string {
	out := make([]string, len(Table))
	for i, k := range Table {
		out[i] = k.Name
	}
	return out
}

// Bundle returns the JSON Schema bundle: $defs with every model of the contract.
func Bundle() []byte { return schemaBundle }

var (
	compileOnce sync.Once
	compiler    *jsonschema.Compiler
	compileErr  error
	schemasMu   sync.Mutex
	schemas     = map[string]*jsonschema.Schema{}
)

// compile returns the schema of one $defs entry, compiled once.
func compile(name string) (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		var doc any
		if err := json.Unmarshal(schemaBundle, &doc); err != nil {
			compileErr = fmt.Errorf("schema bundle: %w", err)
			return
		}
		c := jsonschema.NewCompiler()
		if err := c.AddResource("catalog.json", doc); err != nil {
			compileErr = err
			return
		}
		compiler = c
	})
	if compileErr != nil {
		return nil, compileErr
	}
	schemasMu.Lock()
	defer schemasMu.Unlock()
	if s, ok := schemas[name]; ok {
		return s, nil
	}
	s, err := compiler.Compile("catalog.json#/$defs/" + name)
	if err != nil {
		return nil, fmt.Errorf("schema %s: %w", name, err)
	}
	schemas[name] = s
	return s, nil
}

// ValidationError reports where a document violates its schema.
type ValidationError struct {
	Schema string
	Err    error
}

func (e *ValidationError) Error() string { return e.Schema + ": " + e.Err.Error() }
func (e *ValidationError) Unwrap() error { return e.Err }

// Validate checks a JSON document against a named schema of the bundle.
func Validate(schema string, doc json.RawMessage) error {
	sub, err := compile(schema)
	if err != nil {
		return err
	}
	var v any
	if err := json.Unmarshal(doc, &v); err != nil {
		return &ValidationError{Schema: schema, Err: err}
	}
	if err := sub.Validate(v); err != nil {
		return &ValidationError{Schema: schema, Err: summarize(err)}
	}
	return nil
}

// ValidateSpec checks a spec against its kind's schema.
func (k Kind) ValidateSpec(spec json.RawMessage) error { return Validate(k.Spec, spec) }

// ValidateStatus checks a status against its kind's schema; a kind without a status schema
// accepts any object.
func (k Kind) ValidateStatus(status json.RawMessage) error {
	if k.Status == "" {
		return nil
	}
	return Validate(k.Status, status)
}

// summarize turns the library's error tree into one line a client can read.
func summarize(err error) error {
	var ve *jsonschema.ValidationError
	if !errorsAs(err, &ve) {
		return err
	}
	var lines []string
	for _, line := range strings.Split(ve.Error(), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- "))
		if line == "" || strings.HasPrefix(line, "jsonschema validation failed") {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) > 6 {
		lines = append(lines[:6], fmt.Sprintf("and %d more", len(lines)-6))
	}
	return fmt.Errorf("%s", strings.Join(lines, "; "))
}

func errorsAs(err error, target **jsonschema.ValidationError) bool {
	for err != nil {
		if ve, ok := err.(*jsonschema.ValidationError); ok {
			*target = ve
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
