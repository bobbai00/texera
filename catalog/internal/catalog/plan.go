package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// logicalPlan is what the engine compiles: operators with their properties inlined and
// links by port ordinal.
type logicalPlan struct {
	Operators        []map[string]any `json:"operators"`
	Links            []logicalLink    `json:"links"`
	OpsToViewResult  []string         `json:"opsToViewResult"`
	OpsToReuseResult []string         `json:"opsToReuseResult"`
}

type logicalLink struct {
	FromOpID   string       `json:"fromOpId"`
	FromPortID portIdentity `json:"fromPortId"`
	ToOpID     string       `json:"toOpId"`
	ToPortID   portIdentity `json:"toPortId"`
}

type portIdentity struct {
	ID       int  `json:"id"`
	Internal bool `json:"internal"`
}

// defaultPorts fills the ports a workflow spec leaves out: one input unless the operator is a
// source, one output.
func defaultPorts(spec *api.WorkflowSpec) {
	for i := range spec.Operators {
		op := &spec.Operators[i]
		if op.OperatorProperties == nil {
			op.OperatorProperties = map[string]any{}
		}
		if (op.InputPorts == nil || len(*op.InputPorts) == 0) && !isSourceType(op.OperatorType) {
			op.InputPorts = &[]api.WorkflowPort{{PortID: "input-0"}}
		}
		if op.OutputPorts == nil || len(*op.OutputPorts) == 0 {
			op.OutputPorts = &[]api.WorkflowPort{{PortID: "output-0"}}
		}
	}
}

func isSourceType(t string) bool {
	lt := strings.ToLower(t)
	return strings.Contains(lt, "scan") || strings.Contains(lt, "source") || strings.Contains(lt, "generator")
}

// validateGraph checks the structural rules the engine assumes.
func validateGraph(spec *api.WorkflowSpec) error {
	seen := map[string]*api.WorkflowOperator{}
	for i := range spec.Operators {
		op := &spec.Operators[i]
		if op.OperatorID == "" {
			return Invalid(fmt.Sprintf("operator %d has no operatorID", i), nil)
		}
		if op.OperatorType == "" {
			return Invalid("operator "+op.OperatorID+" has no operatorType", nil)
		}
		if seen[op.OperatorID] != nil {
			return Invalid("duplicate operatorID "+op.OperatorID, nil)
		}
		seen[op.OperatorID] = op
	}
	for _, l := range spec.Links {
		src, ok := seen[l.Source.OperatorID]
		if !ok {
			return Invalid(fmt.Sprintf("link %s: unknown source operator %s", l.LinkID, l.Source.OperatorID), nil)
		}
		dst, ok := seen[l.Target.OperatorID]
		if !ok {
			return Invalid(fmt.Sprintf("link %s: unknown target operator %s", l.LinkID, l.Target.OperatorID), nil)
		}
		if portIndex(src.OutputPorts, l.Source.PortID) < 0 {
			return Invalid(fmt.Sprintf("link %s: operator %s has no output port %s", l.LinkID, src.OperatorID, l.Source.PortID), nil)
		}
		if portIndex(dst.InputPorts, l.Target.PortID) < 0 {
			return Invalid(fmt.Sprintf("link %s: operator %s has no input port %s", l.LinkID, dst.OperatorID, l.Target.PortID), nil)
		}
	}
	return nil
}

func portIndex(ports *[]api.WorkflowPort, id string) int {
	if ports == nil {
		return -1
	}
	for i, p := range *ports {
		if p.PortID == id {
			return i
		}
	}
	return -1
}

// resolvedPlan is a workflow spec made runnable: custom operators compiled, dataset files
// replaced by URLs the unit can read.
type resolvedPlan struct {
	Plan   logicalPlan
	Inputs []engine.ResolvedInput
	// InputURIs are the dataset file URIs read, for the execution's spec and the used edges.
	InputURIs []string
	// Used maps each input URI to the operator and port that reads it.
	Used map[string]string
}

// buildPlan turns a workflow spec into the engine's plan.
func (s *Service) buildPlan(ctx context.Context, caller *auth.Caller, spec api.WorkflowSpec) (*resolvedPlan, error) {
	defaultPorts(&spec)
	if err := validateGraph(&spec); err != nil {
		return nil, err
	}
	out := &resolvedPlan{Used: map[string]string{}}
	enabled := map[string]*api.WorkflowOperator{}
	plan := logicalPlan{Operators: []map[string]any{}, Links: []logicalLink{}, OpsToViewResult: []string{}, OpsToReuseResult: []string{}}
	for i := range spec.Operators {
		op := &spec.Operators[i]
		if op.IsDisabled != nil && *op.IsDisabled {
			continue
		}
		enabled[op.OperatorID] = op
		logical := map[string]any{}
		for k, v := range op.OperatorProperties {
			logical[k] = v
		}
		operatorType := op.OperatorType
		if uri.Is(operatorType) {
			compiled, err := s.compileCustomOperator(ctx, caller, operatorType)
			if err != nil {
				return nil, err
			}
			operatorType = "PythonUDFV2"
			for k, v := range compiled {
				logical[k] = v
			}
		}
		// Dataset files become URLs the unit reads.
		for pointer, ref := range uri.Extract(logical) {
			if ref.Kind.Name != "dataset" || ref.Vno == 0 || !strings.HasPrefix(ref.Subresource, "files/") {
				continue
			}
			input, err := s.resolveInput(ctx, caller, ref)
			if err != nil {
				return nil, Invalid(fmt.Sprintf("operator %s: %v", op.OperatorID, err), map[string]any{"field": pointer})
			}
			setPointer(logical, pointer, input.Url)
			out.Inputs = append(out.Inputs, *input)
			out.InputURIs = append(out.InputURIs, ref.String())
			out.Used[ref.String()] = op.OperatorID
		}
		logical["operatorID"] = op.OperatorID
		logical["operatorType"] = operatorType
		logical["inputPorts"] = portsJSON(op.InputPorts)
		logical["outputPorts"] = portsJSON(op.OutputPorts)
		plan.Operators = append(plan.Operators, logical)
		if op.ViewResult != nil && *op.ViewResult {
			plan.OpsToViewResult = append(plan.OpsToViewResult, op.OperatorID)
		}
		if op.MarkedForReuse != nil && *op.MarkedForReuse {
			plan.OpsToReuseResult = append(plan.OpsToReuseResult, op.OperatorID)
		}
	}
	for _, l := range spec.Links {
		src, ok1 := enabled[l.Source.OperatorID]
		dst, ok2 := enabled[l.Target.OperatorID]
		if !ok1 || !ok2 {
			continue
		}
		plan.Links = append(plan.Links, logicalLink{
			FromOpID: l.Source.OperatorID, FromPortID: portIdentity{ID: portIndex(src.OutputPorts, l.Source.PortID)},
			ToOpID: l.Target.OperatorID, ToPortID: portIdentity{ID: portIndex(dst.InputPorts, l.Target.PortID)},
		})
	}
	out.Plan = plan
	return out, nil
}

// compileCustomOperator turns a custom operator version into the properties of the engine's
// Python UDF operator.
func (s *Service) compileCustomOperator(ctx context.Context, caller *auth.Caller, name string) (map[string]any, error) {
	ref, err := uri.Parse(name)
	if err != nil || ref.Kind.Name != "operator" {
		return nil, Invalid("operatorType "+name+" is not an operator URI", nil)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, Invalid("operatorType "+name+": bad id", nil)
	}
	k, _ := kinds.ByName("operator")
	_, v, err := s.Version(ctx, caller, &k, rid, ref.Vno)
	if err != nil {
		return nil, err
	}
	var spec api.OperatorSpec
	if err := json.Unmarshal(v.Content, &spec); err != nil {
		return nil, err
	}
	if spec.Implementation == nil || spec.Implementation.Python == nil || strings.TrimSpace(spec.Implementation.Python.Code) == "" {
		return nil, Invalid(name+" has no Python implementation", nil)
	}
	// The engine's Python operator keeps the input columns and needs the added ones declared.
	columns := []api.Attribute{}
	if spec.Implementation.Python.OutputColumns != nil {
		columns = *spec.Implementation.Python.OutputColumns
	}
	props := map[string]any{"code": spec.Implementation.Python.Code, "workers": 1, "retainInputColumns": true, "defaultEnv": true, "outputColumns": columns}
	return props, nil
}

// resolveInput checks a dataset file and presigns it for the unit.
func (s *Service) resolveInput(ctx context.Context, caller *auth.Caller, ref uri.Ref) (*engine.ResolvedInput, error) {
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, err
	}
	k, _ := kinds.ByName("dataset")
	path := strings.TrimPrefix(ref.Subresource, "files/")
	f, err := s.File(ctx, caller, k, rid, ref.Vno, path)
	if err != nil {
		return nil, err
	}
	link, err := s.Link(ctx, caller, k, rid, ref.Vno, path)
	if err != nil {
		return nil, err
	}
	size := f.Size
	return &engine.ResolvedInput{Dataset: rid.String(), Vno: int32(ref.Vno), Path: f.Path, Url: link.Url, SizeBytes: &size}, nil
}

func portsJSON(ports *[]api.WorkflowPort) []map[string]any {
	out := []map[string]any{}
	if ports == nil {
		return out
	}
	for _, p := range *ports {
		out = append(out, map[string]any{"portID": p.PortID, "displayName": deref(p.DisplayName), "allowMultiInputs": derefBool(p.AllowMultiInputs), "isDynamicPort": derefBool(p.IsDynamicPort)})
	}
	return out
}

// setPointer writes a value at a JSON pointer inside a document of maps and slices.
func setPointer(doc any, pointer string, value any) {
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	cur := doc
	for i, raw := range parts {
		key := strings.ReplaceAll(strings.ReplaceAll(raw, "~1", "/"), "~0", "~")
		last := i == len(parts)-1
		switch c := cur.(type) {
		case map[string]any:
			if last {
				c[key] = value
				return
			}
			cur = c[key]
		case []any:
			var idx int
			if _, err := fmt.Sscanf(key, "%d", &idx); err != nil || idx < 0 || idx >= len(c) {
				return
			}
			if last {
				c[idx] = value
				return
			}
			cur = c[idx]
		default:
			return
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefBool(b *bool) bool { return b != nil && *b }

// usedEdges are the arrows from an execution to the dataset files it read.
func usedEdges(exec *store.Resource, execURI string, plan *resolvedPlan) []store.Edge {
	var edges []store.Edge
	for _, name := range plan.InputURIs {
		ref, err := uri.Parse(name)
		if err != nil {
			continue
		}
		to, _ := uuid.Parse(ref.Rid)
		toRID := to
		execRID := exec.RID
		attrs := mustJSON(map[string]any{"operatorID": plan.Used[name]})
		edges = append(edges, store.Edge{From: execURI, Relation: "used", To: name, FromRID: exec.RID, ToRID: &toRID, ExecutionRID: &execRID, Attrs: attrs})
	}
	return edges
}

var _ = authz.Read
