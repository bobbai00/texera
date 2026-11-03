package server

import (
	"encoding/json"
	"fmt"
	"strings"
)

// WorkflowContent is the stored workflow format (what the editor and the agents write).
type WorkflowContent struct {
	Operators []ContentOperator `json:"operators"`
	Links     []ContentLink     `json:"links"`
}

// ContentOperator is one operator in the stored format.
type ContentOperator struct {
	OperatorID         string         `json:"operatorID"`
	OperatorType       string         `json:"operatorType"`
	OperatorVersion    string         `json:"operatorVersion,omitempty"`
	OperatorProperties map[string]any `json:"operatorProperties"`
	InputPorts         []ContentPort  `json:"inputPorts"`
	OutputPorts        []ContentPort  `json:"outputPorts"`
	ViewResult         bool           `json:"viewResult,omitempty"`
	MarkedForReuse     bool           `json:"markedForReuse,omitempty"`
	IsDisabled         bool           `json:"isDisabled,omitempty"`
	CustomDisplayName  string         `json:"customDisplayName,omitempty"`
}

// ContentPort is a port in the stored format.
type ContentPort struct {
	PortID      string `json:"portID"`
	DisplayName string `json:"displayName,omitempty"`
	AllowMulti  bool   `json:"allowMultiInputs,omitempty"`
	IsDynamic   bool   `json:"isDynamicPort,omitempty"`
}

// ContentLink is a link in the stored format.
type ContentLink struct {
	LinkID string       `json:"linkID"`
	Source ContentPort2 `json:"source"`
	Target ContentPort2 `json:"target"`
}

// ContentPort2 names an operator's port.
type ContentPort2 struct {
	OperatorID string `json:"operatorID"`
	PortID     string `json:"portID"`
}

// LogicalPlan is what the engine compiles: operators with their properties inlined and
// links by port ordinal.
type LogicalPlan struct {
	Operators        []map[string]any `json:"operators"`
	Links            []LogicalLink    `json:"links"`
	OpsToViewResult  []string         `json:"opsToViewResult"`
	OpsToReuseResult []string         `json:"opsToReuseResult"`
}

// LogicalLink is a link in the engine's format.
type LogicalLink struct {
	FromOpID   string       `json:"fromOpId"`
	FromPortID PortIdentity `json:"fromPortId"`
	ToOpID     string       `json:"toOpId"`
	ToPortID   PortIdentity `json:"toPortId"`
}

// PortIdentity is a port ordinal.
type PortIdentity struct {
	ID       int  `json:"id"`
	Internal bool `json:"internal"`
}

// ParseContent decodes a stored workflow, filling default ports when absent.
func ParseContent(raw json.RawMessage) (*WorkflowContent, error) {
	var c WorkflowContent
	if len(raw) == 0 {
		return &c, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("workflow content: %w", err)
	}
	for i := range c.Operators {
		op := &c.Operators[i]
		if op.OperatorProperties == nil {
			op.OperatorProperties = map[string]any{}
		}
		if len(op.InputPorts) == 0 && !isSourceType(op.OperatorType) {
			op.InputPorts = []ContentPort{{PortID: "input-0"}}
		}
		if len(op.OutputPorts) == 0 {
			op.OutputPorts = []ContentPort{{PortID: "output-0"}}
		}
	}
	return &c, nil
}

func isSourceType(t string) bool {
	lt := strings.ToLower(t)
	return strings.Contains(lt, "scan") || strings.Contains(lt, "source") || strings.Contains(lt, "generator")
}

// Validate checks the structural rules the engine assumes: unique ids, links between
// existing ports, no disabled endpoints.
func (c *WorkflowContent) Validate() error {
	seen := map[string]*ContentOperator{}
	for i := range c.Operators {
		op := &c.Operators[i]
		if op.OperatorID == "" {
			return fmt.Errorf("operator %d has no operatorID", i)
		}
		if op.OperatorType == "" {
			return fmt.Errorf("operator %s has no operatorType", op.OperatorID)
		}
		if seen[op.OperatorID] != nil {
			return fmt.Errorf("duplicate operatorID %s", op.OperatorID)
		}
		seen[op.OperatorID] = op
	}
	for _, l := range c.Links {
		src, ok := seen[l.Source.OperatorID]
		if !ok {
			return fmt.Errorf("link %s: unknown source operator %s", l.LinkID, l.Source.OperatorID)
		}
		dst, ok := seen[l.Target.OperatorID]
		if !ok {
			return fmt.Errorf("link %s: unknown target operator %s", l.LinkID, l.Target.OperatorID)
		}
		if portIndex(src.OutputPorts, l.Source.PortID) < 0 {
			return fmt.Errorf("link %s: operator %s has no output port %s", l.LinkID, src.OperatorID, l.Source.PortID)
		}
		if portIndex(dst.InputPorts, l.Target.PortID) < 0 {
			return fmt.Errorf("link %s: operator %s has no input port %s", l.LinkID, dst.OperatorID, l.Target.PortID)
		}
	}
	return nil
}

func portIndex(ports []ContentPort, id string) int {
	for i, p := range ports {
		if p.PortID == id {
			return i
		}
	}
	return -1
}

// ToLogicalPlan converts enabled operators and their links into the engine's format.
func (c *WorkflowContent) ToLogicalPlan() LogicalPlan {
	enabled := map[string]*ContentOperator{}
	plan := LogicalPlan{Operators: []map[string]any{}, Links: []LogicalLink{}, OpsToViewResult: []string{}, OpsToReuseResult: []string{}}
	for i := range c.Operators {
		op := &c.Operators[i]
		if op.IsDisabled {
			continue
		}
		enabled[op.OperatorID] = op
		logical := map[string]any{}
		for k, v := range op.OperatorProperties {
			logical[k] = v
		}
		logical["operatorID"] = op.OperatorID
		logical["operatorType"] = op.OperatorType
		logical["inputPorts"] = portsJSON(op.InputPorts)
		logical["outputPorts"] = portsJSON(op.OutputPorts)
		plan.Operators = append(plan.Operators, logical)
		if op.ViewResult {
			plan.OpsToViewResult = append(plan.OpsToViewResult, op.OperatorID)
		}
		if op.MarkedForReuse {
			plan.OpsToReuseResult = append(plan.OpsToReuseResult, op.OperatorID)
		}
	}
	for _, l := range c.Links {
		src, ok1 := enabled[l.Source.OperatorID]
		dst, ok2 := enabled[l.Target.OperatorID]
		if !ok1 || !ok2 {
			continue
		}
		plan.Links = append(plan.Links, LogicalLink{
			FromOpID:   l.Source.OperatorID,
			FromPortID: PortIdentity{ID: portIndex(src.OutputPorts, l.Source.PortID)},
			ToOpID:     l.Target.OperatorID,
			ToPortID:   PortIdentity{ID: portIndex(dst.InputPorts, l.Target.PortID)},
		})
	}
	return plan
}

func portsJSON(ports []ContentPort) []map[string]any {
	out := make([]map[string]any, 0, len(ports))
	for _, p := range ports {
		m := map[string]any{"portID": p.PortID, "displayName": p.DisplayName, "allowMultiInputs": p.AllowMulti, "isDynamicPort": p.IsDynamic}
		out = append(out, m)
	}
	return out
}

// DatasetRef is a parsed dataset:// URI: dataset://{rid}[@{vno}]/{path}.
type DatasetRef struct {
	RID  string
	Vno  int32
	Path string
}

// ParseDatasetURI parses a dataset URI; ok is false for other strings.
func ParseDatasetURI(s string) (DatasetRef, bool) {
	const scheme = "dataset://"
	if !strings.HasPrefix(s, scheme) {
		return DatasetRef{}, false
	}
	rest := strings.TrimPrefix(s, scheme)
	idPart, path, _ := strings.Cut(rest, "/")
	ref := DatasetRef{Path: path}
	if id, v, ok := strings.Cut(idPart, "@"); ok {
		ref.RID = id
		var n int32
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			ref.Vno = n
		}
	} else {
		ref.RID = idPart
	}
	if ref.RID == "" {
		return DatasetRef{}, false
	}
	return ref, true
}

// String renders the URI.
func (r DatasetRef) String() string {
	if r.Vno > 0 {
		return fmt.Sprintf("dataset://%s@%d/%s", r.RID, r.Vno, r.Path)
	}
	return fmt.Sprintf("dataset://%s/%s", r.RID, r.Path)
}

// FindDatasetRefs returns every dataset URI in an operator's properties, with the property
// path (dot-joined) where it sits.
func FindDatasetRefs(props map[string]any) map[string]DatasetRef {
	out := map[string]DatasetRef{}
	var walk func(prefix string, v any)
	walk = func(prefix string, v any) {
		switch t := v.(type) {
		case string:
			if ref, ok := ParseDatasetURI(t); ok {
				out[prefix] = ref
			}
		case map[string]any:
			for k, vv := range t {
				p := k
				if prefix != "" {
					p = prefix + "." + k
				}
				walk(p, vv)
			}
		case []any:
			for i, vv := range t {
				walk(fmt.Sprintf("%s[%d]", prefix, i), vv)
			}
		}
	}
	walk("", props)
	return out
}

// SetProperty writes a value at a dot-joined property path produced by FindDatasetRefs.
func SetProperty(props map[string]any, path string, value any) {
	parts := strings.Split(path, ".")
	cur := props
	for i, p := range parts {
		if i == len(parts)-1 {
			cur[p] = value
			return
		}
		next, ok := cur[p].(map[string]any)
		if !ok {
			return
		}
		cur = next
	}
}
