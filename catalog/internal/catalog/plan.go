package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
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
		// An operator that lists no ports gets the ones its links use: no link is lost.
		if op.InputPorts == nil || len(*op.InputPorts) == 0 {
			if used := usedPorts(spec.Links, op.OperatorID, true); len(used) > 0 {
				op.InputPorts = &used
			} else if !isSourceType(op.OperatorType) {
				op.InputPorts = &[]api.WorkflowPort{{PortID: "input-0"}}
			}
		}
		if op.OutputPorts == nil || len(*op.OutputPorts) == 0 {
			if used := usedPorts(spec.Links, op.OperatorID, false); len(used) > 0 {
				op.OutputPorts = &used
			} else {
				op.OutputPorts = &[]api.WorkflowPort{{PortID: "output-0"}}
			}
		}
	}
}

// usedPorts is the ports an operator's links use, its inputs or its outputs, in port order.
func usedPorts(links []api.WorkflowLink, operatorID string, inputs bool) []api.WorkflowPort {
	seen := map[string]bool{}
	var used []api.WorkflowPort
	for _, l := range links {
		end := l.Source
		if inputs {
			end = l.Target
		}
		if end.OperatorID == operatorID && !seen[end.PortID] {
			seen[end.PortID] = true
			used = append(used, api.WorkflowPort{PortID: end.PortID})
		}
	}
	sort.Slice(used, func(i, j int) bool { return portNumber(used[i].PortID) < portNumber(used[j].PortID) })
	return used
}

// portNumber is the number at the end of a port's id: 1 for "input-1".
func portNumber(portID string) int {
	n, _ := strconv.Atoi(portID[strings.LastIndex(portID, "-")+1:])
	return n
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
		if engineOnly[op.OperatorType] {
			return engineOnlyRefusal(op.OperatorID, op.OperatorType)
		}
		// The engine names what a port keeps after its operator and refuses '_' in that name, so
		// an execution would start and never end.
		if strings.Contains(op.OperatorID, "_") {
			return Invalid(fmt.Sprintf("operator %s: an operatorID may not contain '_', which the engine cannot keep results under; use '-', as in %s",
				op.OperatorID, strings.ReplaceAll(op.OperatorID, "_", "-")), map[string]any{"operator": op.OperatorID})
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

// credentialRefs finds every credential URI among an operator's properties, by JSON pointer.
func credentialRefs(props map[string]any) []secretRef {
	var out []secretRef
	var walk func(v any, pointer string)
	walk = func(v any, pointer string) {
		switch t := v.(type) {
		case map[string]any:
			for k, child := range t {
				walk(child, pointer+"/"+strings.NewReplacer("~", "~0", "/", "~1").Replace(k))
			}
		case []any:
			for i, child := range t {
				walk(child, fmt.Sprintf("%s/%d", pointer, i))
			}
		case string:
			if !strings.HasPrefix(t, credentialPrefix) {
				return
			}
			base, field, _ := strings.Cut(t, "#")
			ref, err := uri.Parse(base)
			if err != nil || ref.Kind.Name != "credential" {
				return
			}
			rid, err := uuid.Parse(ref.Rid)
			if err != nil {
				return
			}
			if field == "" {
				field = "value"
			}
			out = append(out, secretRef{Pointer: pointer, RID: rid, Field: field, URI: t})
		}
	}
	walk(props, "")
	return out
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

// compiled is a workflow version turned into what an execution needs, as data: the engine's logical
// plan with dataset files and credentials still named by URI, the custom operators compiled in,
// and what the execution reads, writes and needs. Nothing in it is a secret or a URL that expires;
// those are bound when the execution materializes, into a copy, and never stored.
type compiled struct {
	Plan logicalPlan
	// Inputs are the dataset files the plan reads, each at a JSON pointer of its operator.
	Inputs []inputRef
	// Secrets are the credentials the properties name, each at a JSON pointer of its operator.
	Secrets []secretRef
	// Operators are the custom operator versions compiled in, as URIs with @vno.
	Operators []string
	// Outputs are the execution's tables, one per output port, named by the catalog: those the
	// run shows, and the kept results of its costliest operators.
	Outputs []api.PortTable
	// Shown are the ports the run must show, by port key.
	Shown map[string]bool
	// Reusable are the operators whose rows a later run could reuse.
	Reusable map[string]bool
	// Fingerprints are the work that makes each reusable port, once the unit is known.
	Fingerprints map[string]string
}

// inputRef is a dataset file an operator property names.
type inputRef struct {
	URI        string
	Ref        uri.Ref
	Operator   int
	OperatorID string
	Pointer    string
}

// secretRef is a credential a property names: `texera://credentials/{rid}[#field]`.
type secretRef struct {
	Operator int
	Pointer  string
	RID      uuid.UUID
	Field    string
	URI      string
}

const credentialPrefix = uri.Scheme + "credentials/"

// compile turns a workflow spec into a plan, reading only what the store holds: no permission
// is checked here (authorizePlan does that, on what compile found) and nothing is written.
// upTo is the part of a workflow a run up to an operator runs: the operator and everything it
// reads from, directly or not, with the links between them. Nothing reads from the operator
// there, so its result is kept by the rule that keeps the result of an operator nothing reads
// from.
func upTo(spec api.WorkflowSpec, operatorID string) (api.WorkflowSpec, error) {
	byID := map[string]api.WorkflowOperator{}
	for _, op := range spec.Operators {
		byID[op.OperatorID] = op
	}
	target, ok := byID[operatorID]
	if !ok {
		return spec, Invalid(fmt.Sprintf("no operator %s in this version", operatorID), map[string]any{"field": "upTo"})
	}
	if target.IsDisabled != nil && *target.IsDisabled {
		return spec, Invalid(fmt.Sprintf("operator %s is turned off", operatorID), map[string]any{"field": "upTo"})
	}
	inputs := map[string][]string{}
	for _, l := range spec.Links {
		inputs[l.Target.OperatorID] = append(inputs[l.Target.OperatorID], l.Source.OperatorID)
	}
	keep := map[string]bool{}
	for next := []string{operatorID}; len(next) > 0; {
		id := next[len(next)-1]
		next = next[:len(next)-1]
		if keep[id] {
			continue
		}
		keep[id] = true
		next = append(next, inputs[id]...)
	}
	part := spec
	part.Operators = nil
	part.Links = nil
	for _, op := range spec.Operators {
		if keep[op.OperatorID] {
			part.Operators = append(part.Operators, op)
		}
	}
	for _, l := range spec.Links {
		if keep[l.Source.OperatorID] && keep[l.Target.OperatorID] {
			part.Links = append(part.Links, l)
		}
	}
	return part, nil
}

func (s *Service) compile(ctx context.Context, spec api.WorkflowSpec, project *uuid.UUID) (*compiled, error) {
	defaultPorts(&spec)
	if err := validateGraph(&spec); err != nil {
		return nil, err
	}
	if err := s.offered(ctx, &spec, project); err != nil {
		return nil, err
	}
	out := &compiled{Outputs: []api.PortTable{}}
	enabled := map[string]*api.WorkflowOperator{}
	// The functions that may give other rows for the same input, by operator id.
	nondeterministic := map[string]bool{}
	plan := logicalPlan{Operators: []map[string]any{}, Links: []logicalLink{}, OpsToViewResult: []string{}, OpsToReuseResult: []string{}}
	for i := range spec.Operators {
		op := &spec.Operators[i]
		if op.IsDisabled != nil && *op.IsDisabled {
			continue
		}
		enabled[op.OperatorID] = op
		props := map[string]any{}
		for k, v := range op.OperatorProperties {
			props[k] = v
		}
		index := len(plan.Operators)
		refs := credentialRefs(props)
		var logical map[string]any
		operatorType := op.OperatorType
		if uri.Is(operatorType) {
			custom, err := s.compileCustomOperator(ctx, operatorType, props)
			if err != nil {
				return nil, err
			}
			operatorType, logical = custom.engineType, custom.logical
			if custom.nondeterministic {
				nondeterministic[op.OperatorID] = true
			}
			if custom.inputs == 0 {
				// A function that reads no table is a source: nothing links into it.
				if len(usedPorts(spec.Links, op.OperatorID, true)) > 0 {
					return nil, Invalid(fmt.Sprintf("operator %s reads no table, so nothing links into it", op.OperatorID), map[string]any{"operator": op.OperatorID})
				}
				op.InputPorts = &[]api.WorkflowPort{}
			}
			// A function's settings are its arguments, so a secret goes where they are.
			for i := range refs {
				refs[i].Pointer = "/args" + refs[i].Pointer
			}
			out.Operators = appendUnique(out.Operators, custom.version)
		} else {
			logical = props
		}
		if operatorType == predictType {
			if err := s.compilePredict(ctx, logical); err != nil {
				return nil, Invalid(fmt.Sprintf("operator %s: %v", op.OperatorID, err), map[string]any{"field": "model"})
			}
		}
		for _, ref := range refs {
			ref.Operator = index
			out.Secrets = append(out.Secrets, ref)
		}
		for pointer, ref := range uri.Extract(logical) {
			// The files it reads, of a dataset or a model version.
			if (ref.Kind.Name != "dataset" && ref.Kind.Name != "model") || ref.Vno == 0 || !strings.HasPrefix(ref.Subresource, "files/") {
				continue
			}
			if err := s.fileExists(ctx, ref); err != nil {
				return nil, Invalid(fmt.Sprintf("operator %s: %v", op.OperatorID, err), map[string]any{"field": pointer})
			}
			out.Inputs = append(out.Inputs, inputRef{URI: ref.String(), Ref: ref, Operator: index, OperatorID: op.OperatorID, Pointer: pointer})
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
	downstream := map[string]bool{}
	for _, l := range spec.Links {
		src, ok1 := enabled[l.Source.OperatorID]
		dst, ok2 := enabled[l.Target.OperatorID]
		if !ok1 || !ok2 {
			continue
		}
		downstream[l.Source.OperatorID] = true
		plan.Links = append(plan.Links, logicalLink{
			FromOpID: l.Source.OperatorID, FromPortID: portIdentity{ID: portIndex(src.OutputPorts, l.Source.PortID)},
			ToOpID: l.Target.OperatorID, ToPortID: portIdentity{ID: portIndex(dst.InputPorts, l.Target.PortID)},
		})
	}
	// The tables: one per output port the engine materializes, which are the ports of the
	// operators marked to view their result and of the operators nothing reads (the engine's
	// own rule); the other ports flow through and have no table.
	for _, logical := range plan.Operators {
		op := enabled[logical["operatorID"].(string)]
		if !(op.ViewResult != nil && *op.ViewResult) && downstream[op.OperatorID] {
			continue
		}
		if op.OutputPorts != nil {
			for _, port := range *op.OutputPorts {
				out.Outputs = append(out.Outputs, api.PortTable{OperatorID: op.OperatorID, PortID: port.PortID, Table: tableName(op.OperatorID, port.PortID)})
			}
		}
	}
	// The results that cost the most to make are kept even when nothing shows them, so a later
	// run can read them instead of making them again.
	out.Shown = map[string]bool{}
	shown := true
	for i, o := range out.Outputs {
		out.Shown[portKey(o.OperatorID, o.PortID)] = true
		out.Outputs[i].Shown = &shown
	}
	out.Reusable = reusableOps(plan, nondeterministic)
	for _, logical := range plan.Operators {
		id := opID(logical)
		if !keptTypes[opType(logical)] || !out.Reusable[id] {
			continue
		}
		for _, port := range outputPortIDs(logical) {
			if !out.Shown[portKey(id, port)] {
				out.Outputs = append(out.Outputs, api.PortTable{OperatorID: id, PortID: port, Table: tableName(id, port)})
				plan.OpsToViewResult = appendUnique(plan.OpsToViewResult, id)
			}
		}
	}
	out.Plan = plan
	return out, nil
}

// tableName is the table an output port writes, inside the execution's namespace: the operator and
// the port, in the characters a table name may carry.
func tableName(operatorID, portID string) string {
	clean := func(s string) string {
		var b strings.Builder
		for _, r := range strings.ToLower(s) {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			} else {
				b.WriteRune('_')
			}
		}
		return b.String()
	}
	return clean(operatorID) + "_" + clean(portID)
}

func appendUnique(list []string, item string) []string {
	for _, x := range list {
		if x == item {
			return list
		}
	}
	return append(list, item)
}

// fileExists checks that a dataset version holds the file a URI names.
func (s *Service) fileExists(ctx context.Context, ref uri.Ref) error {
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return fmt.Errorf("%s: bad %s id", ref.String(), ref.Kind.Name)
	}
	v, err := s.Store.GetVersion(ctx, rid, ref.Vno)
	if err != nil {
		return fmt.Errorf("%s: no such %s version", ref.String(), ref.Kind.Name)
	}
	var m api.Manifest
	if err := json.Unmarshal(v.Content, &m); err != nil {
		return fmt.Errorf("%s: not a %s version", ref.String(), ref.Kind.Name)
	}
	path := strings.TrimPrefix(ref.Subresource, "files/")
	for _, f := range m.Files {
		if f.Path == path {
			return nil
		}
	}
	return fmt.Errorf("%s: no such file", ref.String())
}

// functionType is the engine's operator a Python function runs as.
const functionType = "function"

// compiledCustom is a custom operator as the engine runs it: the engine's operator type and its
// properties, and the version compiled in, as a URI with @vno.
type compiledCustom struct {
	engineType string
	logical    map[string]any
	version    string
	// inputs is how many tables it reads: none for a source.
	inputs int
	// nondeterministic: a function that may give other rows for the same input.
	nondeterministic bool
}

// compileCustomOperator turns a custom operator, at the version its URI names, into the engine
// operator that runs it: its function into `function`, called with the instance's settings.
func (s *Service) compileCustomOperator(ctx context.Context, name string, instance map[string]any) (*compiledCustom, error) {
	ref, err := uri.Parse(name)
	if err != nil || ref.Kind.Name != "operator" {
		return nil, Invalid("operatorType "+name+" is not an operator URI", nil)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, Invalid("operatorType "+name+": bad id", nil)
	}
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil || r.Kind != "operator" {
		return nil, NotFound("operator " + ref.Rid)
	}
	vno := ref.Vno
	if vno == 0 {
		vno = r.HeadVno
	}
	v, err := s.Store.GetVersion(ctx, rid, vno)
	if err != nil {
		return nil, NotFound(fmt.Sprintf("version %d of operator %s", vno, r.Name))
	}
	var spec api.OperatorSpec
	if err := json.Unmarshal(v.Content, &spec); err != nil {
		return nil, err
	}
	if spec.Implementation == nil || spec.Implementation.Python == nil || strings.TrimSpace(spec.Implementation.Python.Code) == "" {
		return nil, Invalid(name+" has no Python implementation", nil)
	}
	py := spec.Implementation.Python
	columns := []api.Attribute{}
	if py.OutputColumns != nil {
		columns = *py.OutputColumns
	}
	version := URI(r).WithVersion(vno).String()
	if py.Function == nil || *py.Function == "" {
		// Saved before an operator had to be a function: its code is a class of the engine's.
		return nil, Invalid(fmt.Sprintf("%s is not a function under @returns(...): save its code again as one", name), map[string]any{"field": "operatorType"})
	}
	returns := make([]string, len(columns))
	for i, a := range columns {
		returns[i] = a.AttributeName + " " + a.AttributeType
	}
	// Its inputs, by name; none for a function that reads no table, a source.
	inputs := []string{}
	if spec.InputPorts != nil {
		for _, p := range *spec.InputPorts {
			name := ""
			if p.DisplayName != nil {
				name = *p.DisplayName
			}
			inputs = append(inputs, name)
		}
	}
	args := map[string]any{}
	props := map[string]any{"code": py.Code, "function": *py.Function, "returns": returns, "inputs": inputs, "args": args}
	for k, value := range instance {
		if k == bySetting {
			props[bySetting] = value
		} else {
			args[k] = value
		}
	}
	nondeterministic := py.Nondeterministic != nil && *py.Nondeterministic
	return &compiledCustom{engineType: functionType, logical: props, version: version, inputs: len(inputs), nondeterministic: nondeterministic}, nil
}

// versionURI pins a resource URI to a version: the one it names, else the head.
func (s *Service) versionURI(ctx context.Context, name, kind string) (string, error) {
	ref, err := uri.Parse(name)
	if err != nil {
		return "", err
	}
	if ref.Kind.Name != kind {
		return "", fmt.Errorf("%s is not a %s", name, kind)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return "", err
	}
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil {
		return "", fmt.Errorf("%s not found", name)
	}
	vno := ref.Vno
	if vno == 0 {
		vno = r.HeadVno
	}
	return URI(r).WithVersion(vno).String(), nil
}

// authorizePlan is the one authorization pass of an execution or a dry run, before anything is
// written: running on the unit, using the warehouse, reading every dataset and every custom
// operator the plan names, using every credential. A refusal says which of them the caller
// lacks and where the workflow names it (all of which the caller read in the workflow), so a
// person a workflow was shared with knows what to ask for, and an agent can say so.
func (s *Service) authorizePlan(ctx context.Context, caller *auth.Caller, c *compiled, unit, warehouse *store.Resource) error {
	if err := s.require(ctx, caller, authz.RunOn, unit.RID); err != nil {
		return refusedFor(err, fmt.Sprintf("you may not run on the computing unit %s: ask its owner to share it with you, or run on another", URI(unit)), URI(unit).String(), "")
	}
	// A dry run keeps no results and names no warehouse.
	if warehouse != nil {
		if err := s.require(ctx, caller, authz.Use, warehouse.RID); err != nil {
			return refusedFor(err, fmt.Sprintf("you may not keep results in the warehouse %s: ask its owner to share it with you, or pick another", URI(warehouse)), URI(warehouse).String(), "")
		}
	}
	seen := map[string]bool{}
	check := func(permission, id string, refused func(err error) error) error {
		key := permission + ":" + id
		if seen[key] {
			return nil
		}
		seen[key] = true
		rid, err := uuid.Parse(id)
		if err != nil {
			return Invalid("bad resource id "+id, nil)
		}
		if err := s.require(ctx, caller, permission, rid); err != nil {
			return refused(err)
		}
		return nil
	}
	for _, in := range c.Inputs {
		if err := check(authz.Read, in.Ref.Rid, func(err error) error {
			return refusedFor(err, fmt.Sprintf("operator %s reads %s, which is not shared with you: ask the workflow's owner to share it with you", in.OperatorID, in.URI), in.URI, in.OperatorID)
		}); err != nil {
			return err
		}
	}
	for _, name := range c.Operators {
		ref, _ := uri.Parse(name)
		if err := check(authz.Read, ref.Rid, func(err error) error {
			return refusedFor(err, fmt.Sprintf("the workflow uses the operator %s, which is not shared with you: ask the workflow's owner to share it with you", name), name, "")
		}); err != nil {
			return err
		}
	}
	for _, ref := range c.Secrets {
		operatorID := ""
		if ref.Operator >= 0 && ref.Operator < len(c.Plan.Operators) {
			operatorID, _ = c.Plan.Operators[ref.Operator]["operatorID"].(string)
		}
		if err := check(authz.Use, ref.RID.String(), func(err error) error {
			return refusedFor(err, fmt.Sprintf("operator %s uses the credential %s, which you may not use: ask its owner to share it with you", operatorID, ref.URI), ref.URI, operatorID)
		}); err != nil {
			return err
		}
	}
	return nil
}

// refusedFor says, in words, what a refusal was about; any other error passes as it is. The
// details name the resource the caller lacks (needs) and the operator that names it.
func refusedFor(err error, msg, needs, operatorID string) error {
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusForbidden {
		return err
	}
	details := map[string]any{"needs": needs}
	if operatorID != "" {
		details["operator"] = operatorID
	}
	return &Error{Status: http.StatusForbidden, Code: e.Code, Message: msg, Details: details}
}

// bindInputs presigns every input into a copy of the plan the engine can read.
func (s *Service) bindInputs(ctx context.Context, caller *auth.Caller, c *compiled) (logicalPlan, []engine.ResolvedInput, error) {
	plan := c.Plan.clone()
	var inputs []engine.ResolvedInput
	for _, in := range c.Inputs {
		input, err := s.resolveInput(ctx, caller, in.Ref)
		if err != nil {
			return plan, nil, Invalid(fmt.Sprintf("operator %s: %v", in.OperatorID, err), map[string]any{"field": in.Pointer})
		}
		setPointer(plan.Operators[in.Operator], in.Pointer, input.Url)
		inputs = append(inputs, *input)
	}
	return plan, inputs, nil
}

// bindSecrets leases every credential the plan names, for the execution given as the purpose,
// and puts the secret where the URI was in the copy: into the operator's properties, which for
// a function are its arguments.
func (s *Service) bindSecrets(ctx context.Context, caller *auth.Caller, plan *logicalPlan, c *compiled, purpose string) error {
	for _, ref := range c.Secrets {
		lease, err := s.Lease(ctx, caller, ref.RID, purpose)
		if err != nil {
			return err
		}
		value, ok := lease.Fields[ref.Field]
		if !ok {
			if len(lease.Fields) == 1 && ref.Field == "value" {
				for _, v := range lease.Fields {
					value = v
				}
			} else {
				return Invalid(fmt.Sprintf("credential %s has no field %q", ref.URI, ref.Field), nil)
			}
		}
		setPointer(plan.Operators[ref.Operator], ref.Pointer, value)
	}
	return nil
}

// clone copies a plan through JSON, so a bound copy never touches the compiled one.
func (p logicalPlan) clone() logicalPlan {
	var out logicalPlan
	_ = json.Unmarshal(mustJSON(p), &out)
	return out
}

// resolveInput checks a dataset file and presigns it for the unit.
func (s *Service) resolveInput(ctx context.Context, caller *auth.Caller, ref uri.Ref) (*engine.ResolvedInput, error) {
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, err
	}
	k, ok := kinds.ByName(ref.Kind.Name)
	if !ok {
		return nil, fmt.Errorf("%s: not a file of a version", ref.String())
	}
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

// apiPlan renders the compiled plan as the contract shows it on an execution.
func (c *compiled) apiPlan(namespace string) api.ExecutionPlan {
	out := api.ExecutionPlan{Outputs: c.Outputs, LogicalPlan: c.Plan}
	if namespace != "" {
		out.Namespace = &namespace
	}
	if len(c.Operators) > 0 {
		ops := make([]api.Uri, len(c.Operators))
		for i, o := range c.Operators {
			ops[i] = api.Uri(o)
		}
		out.Operators = &ops
	}
	if len(c.Secrets) > 0 {
		var creds []api.Uri
		seen := map[string]bool{}
		for _, ref := range c.Secrets {
			if !seen[ref.URI] {
				seen[ref.URI] = true
				creds = append(creds, api.Uri(ref.URI))
			}
		}
		out.Credentials = &creds
	}
	return out
}

// inputURIs are the dataset file URIs a plan reads, each once.
func (c *compiled) inputURIs() []string {
	var out []string
	for _, in := range c.Inputs {
		out = appendUnique(out, in.URI)
	}
	return out
}

// usedEdges are the arrows from an execution to the dataset files it read.
func usedEdges(exec *store.Resource, execURI string, c *compiled) []store.Edge {
	var edges []store.Edge
	seen := map[string]bool{}
	for _, in := range c.Inputs {
		if seen[in.URI] {
			continue
		}
		seen[in.URI] = true
		to, _ := uuid.Parse(in.Ref.Rid)
		toRID := to
		execRID := exec.RID
		attrs := mustJSON(map[string]any{"operatorID": in.OperatorID})
		edges = append(edges, store.Edge{From: execURI, Relation: "used", To: in.URI, FromRID: exec.RID, ToRID: &toRID, ExecutionRID: &execRID, Attrs: attrs})
	}
	return edges
}
