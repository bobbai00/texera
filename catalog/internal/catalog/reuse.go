package catalog

// Results reused across runs.
//
// Every port a run stores carries the fingerprint of the work that made it: the engine
// operator's type and settings, the engine that ran it (and the Python environment, for one that
// runs Python), and its inputs' fingerprints. Settings name versions by number, and a version
// never changes, so one fingerprint means the same rows wherever the work was done. Before a
// run, the catalog looks for the ports the run must make among what the project's completed
// runs stored, as far as the caller may read them; an operator whose results were found is put
// back by a stored source that reads them, keeping its id, and what fed only such operators does
// not run at all.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/store"
)

// storedType is the engine's source that reads a port's stored rows back.
const storedType = "stored"

// reusableTypes are the engine's operators whose rows depend on nothing but their settings,
// their inputs and the engine: the built-ins, the functions and predict. A class-based Python
// operator or a classic one may depend on more, and is made again on every run.
var reusableTypes = map[string]bool{
	"scan": true, "filter": true, "project": true, "compute": true, "aggregate": true, "join": true,
	"union": true, "sort": true, "distinct": true, "limit": true, functionType: true, predictType: true,
}

// keptTypes are those whose results a run stores even when nothing shows them: the ones that
// cost the most to make again.
var keptTypes = map[string]bool{functionType: true, predictType: true, "aggregate": true, "join": true, "sort": true}

// pythonTypes run on Python workers, so their rows depend on the unit's packages too.
var pythonTypes = map[string]bool{functionType: true, predictType: true}

// portKey names a port of a plan: "operatorID/portID".
func portKey(operatorID, portID string) string { return operatorID + "/" + portID }

func opID(op map[string]any) string   { s, _ := op["operatorID"].(string); return s }
func opType(op map[string]any) string { s, _ := op["operatorType"].(string); return s }

// outputPortIDs are an operator's output ports in order, as the plan names them.
func outputPortIDs(op map[string]any) []string {
	var out []string
	switch ports := op["outputPorts"].(type) {
	case []map[string]any:
		for _, p := range ports {
			if id, _ := p["portID"].(string); id != "" {
				out = append(out, id)
			}
		}
	case []any:
		for _, p := range ports {
			if m, ok := p.(map[string]any); ok {
				if id, _ := m["portID"].(string); id != "" {
					out = append(out, id)
				}
			}
		}
	}
	return out
}

// planGraph is a plan's operators by id, in order, with the links into each.
type planGraph struct {
	order []string
	ops   map[string]map[string]any
	into  map[string][]logicalLink
}

func graphOf(plan logicalPlan) planGraph {
	g := planGraph{ops: map[string]map[string]any{}, into: map[string][]logicalLink{}}
	for _, op := range plan.Operators {
		g.order = append(g.order, opID(op))
		g.ops[opID(op)] = op
	}
	for _, l := range plan.Links {
		g.into[l.ToOpID] = append(g.into[l.ToOpID], l)
	}
	return g
}

// sourcePort is the port a link comes from, by the id its operator gives it.
func (g planGraph) sourcePort(l logicalLink) string {
	ports := outputPortIDs(g.ops[l.FromOpID])
	if l.FromPortID.ID >= 0 && l.FromPortID.ID < len(ports) {
		return portKey(l.FromOpID, ports[l.FromPortID.ID])
	}
	return portKey(l.FromOpID, "output-0")
}

// reusableOps are the operators whose rows a later run could reuse: of a reusable type and by
// its rules, with every input reusable. A limit keeps the first rows to arrive, so only after a
// sort; a distinct over some columns keeps the first row of each, so only over all of them; a
// function declared nondeterministic, never.
func reusableOps(plan logicalPlan, nondeterministic map[string]bool) map[string]bool {
	g := graphOf(plan)
	out := map[string]bool{}
	seen := map[string]bool{}
	var visit func(id string) bool
	visit = func(id string) bool {
		if seen[id] {
			return out[id]
		}
		seen[id] = true
		op := g.ops[id]
		ok := reusableTypes[opType(op)] && !nondeterministic[id]
		switch opType(op) {
		case "limit":
			links := g.into[id]
			ok = len(links) == 1 && opType(g.ops[links[0].FromOpID]) == "sort"
		case "distinct":
			cols, _ := op["columns"].([]any)
			ok = len(cols) == 0
		}
		for _, l := range g.into[id] {
			if !visit(l.FromOpID) {
				ok = false
			}
		}
		out[id] = ok
		return ok
	}
	for _, id := range g.order {
		visit(id)
	}
	return out
}

// fingerprints gives each output port of a reusable operator the fingerprint of the work that
// makes it, by port key: the operator's type and settings, the engine, the Python environment
// for one that runs Python, and its inputs' fingerprints in port order.
func fingerprints(plan logicalPlan, reusable map[string]bool, engineVersion, environment string) map[string]string {
	g := graphOf(plan)
	out := map[string]string{}
	var visit func(id string)
	visit = func(id string) {
		op := g.ops[id]
		if !reusable[id] || out[portKey(id, firstPort(op))] != "" {
			return
		}
		// The inputs, by port, each port's links in a fixed order: a union reads them as one.
		byPort := map[int][]string{}
		for _, l := range g.into[id] {
			visit(l.FromOpID)
			byPort[l.ToPortID.ID] = append(byPort[l.ToPortID.ID], out[g.sourcePort(l)])
		}
		var inputs [][]string
		for p := 0; p < len(byPort); p++ {
			sort.Strings(byPort[p])
			inputs = append(inputs, byPort[p])
		}
		settings := map[string]any{}
		for k, v := range op {
			if k != "operatorID" && k != "inputPorts" && k != "outputPorts" {
				settings[k] = v
			}
		}
		work := map[string]any{"engine": engineVersion, "settings": settings, "inputs": inputs}
		if pythonTypes[opType(op)] {
			work["environment"] = environment
		}
		for _, port := range outputPortIDs(op) {
			work["port"] = port
			sum := sha256.Sum256(mustJSON(work))
			out[portKey(id, port)] = hex.EncodeToString(sum[:])
		}
	}
	for _, id := range g.order {
		visit(id)
	}
	return out
}

func firstPort(op map[string]any) string {
	if ports := outputPortIDs(op); len(ports) > 0 {
		return ports[0]
	}
	return "output-0"
}

// storedRows are a port's rows as an earlier run stored them, where the unit can read them.
type storedRows struct {
	// From is the earlier port, as its URI, of the run Execution.
	From      string
	Execution uuid.UUID
	Warehouse string
	Namespace string
	Table     string
	Columns   []engine.Attribute
}

// reuse puts a stored source in place of every costly operator the run needs whose results
// were all found, and drops the operators that only fed those. It starts from the ports the run shows and
// asks find for a port's stored rows only when it might use them. What ran and was read keeps
// its place in the plan's inputs, credentials and custom code. It returns the ports served
// from storage and the operators skipped.
func (c *compiled) reuse(find func(port string) *storedRows) (served map[string]*storedRows, skipped []string) {
	g := graphOf(c.Plan)
	served = map[string]*storedRows{}
	run := map[string]bool{}
	serve := map[string]bool{}
	// Only what costs the most to make is looked for: a cheap operator is made again, reading
	// what was found for it.
	allFound := func(id string) bool {
		op := g.ops[id]
		if !keptTypes[opType(op)] || !c.Reusable[id] {
			return false
		}
		ports := outputPortIDs(op)
		if len(ports) == 0 {
			return false
		}
		for _, p := range ports {
			if c.Fingerprints[portKey(id, p)] == "" {
				return false
			}
		}
		found := map[string]*storedRows{}
		for _, p := range ports {
			rows := find(portKey(id, p))
			if rows == nil {
				return false
			}
			found[portKey(id, p)] = rows
		}
		for k, v := range found {
			served[k] = v
		}
		return true
	}
	var visit func(id string)
	visit = func(id string) {
		if run[id] || serve[id] {
			return
		}
		if allFound(id) {
			serve[id] = true
			return
		}
		run[id] = true
		for _, l := range g.into[id] {
			visit(l.FromOpID)
		}
	}
	for _, id := range g.order {
		for _, p := range outputPortIDs(g.ops[id]) {
			if c.Shown[portKey(id, p)] {
				visit(id)
			}
		}
	}
	if len(serve) == 0 {
		return served, nil
	}

	// The plan again: what runs as it was, what is served as a stored source, the rest gone.
	newIndex := map[int]int{}
	var operators []map[string]any
	for i, op := range c.Plan.Operators {
		id := opID(op)
		switch {
		case run[id]:
			newIndex[i] = len(operators)
			operators = append(operators, op)
		case serve[id]:
			rows := served[portKey(id, firstPort(op))]
			columns := make([]map[string]any, len(rows.Columns))
			for k, a := range rows.Columns {
				columns[k] = map[string]any{"attributeName": a.AttributeName, "attributeType": a.AttributeType}
			}
			operators = append(operators, map[string]any{
				"operatorID": id, "operatorType": storedType,
				"warehouse": rows.Warehouse, "namespace": rows.Namespace, "table": rows.Table,
				"columns": columns, "from": rows.From,
				"inputPorts": []map[string]any{}, "outputPorts": op["outputPorts"],
			})
		default:
			skipped = append(skipped, id)
		}
	}
	var links []logicalLink
	for _, l := range c.Plan.Links {
		if run[l.ToOpID] {
			links = append(links, l)
		}
	}
	// A served operator's rows are copied into this run only where the run shows them.
	shows := func(id string) bool {
		for _, p := range outputPortIDs(g.ops[id]) {
			if c.Shown[portKey(id, p)] {
				return true
			}
		}
		return false
	}
	var views []string
	for _, id := range c.Plan.OpsToViewResult {
		if run[id] || (serve[id] && shows(id)) {
			views = append(views, id)
		}
	}
	var outputs []api.PortTable
	for _, o := range c.Outputs {
		if run[o.OperatorID] || (serve[o.OperatorID] && c.Shown[portKey(o.OperatorID, o.PortID)]) {
			outputs = append(outputs, o)
		}
	}
	var inputs []inputRef
	for _, in := range c.Inputs {
		if i, ok := newIndex[in.Operator]; ok {
			in.Operator = i
			inputs = append(inputs, in)
		}
	}
	var secrets []secretRef
	for _, ref := range c.Secrets {
		if i, ok := newIndex[ref.Operator]; ok {
			ref.Operator = i
			secrets = append(secrets, ref)
		}
	}
	c.Plan.Operators, c.Plan.Links, c.Plan.OpsToViewResult = operators, links, views
	if c.Plan.Links == nil {
		c.Plan.Links = []logicalLink{}
	}
	if c.Plan.OpsToViewResult == nil {
		c.Plan.OpsToViewResult = []string{}
	}
	c.Outputs, c.Inputs, c.Secrets = outputs, inputs, secrets
	return served, skipped
}

// findStored finds a port's rows among what the project's completed runs stored under its
// fingerprint, newest first, in a run the caller may read and a table the unit can open; nil
// when there is none, and the run makes the rows again.
func (s *Service) findStored(ctx context.Context, caller *auth.Caller, fingerprint string, project *uuid.UUID, client *engine.Unit) *storedRows {
	if fingerprint == "" || project == nil {
		return nil
	}
	found, err := s.Store.StoredResults(ctx, fingerprint, *project, 5)
	if err != nil {
		s.Log.Warn("stored results", "err", err)
		return nil
	}
	for _, r := range found {
		exec, err := s.Store.GetResource(ctx, r.Execution)
		if err != nil || s.require(ctx, caller, authz.Read, exec.RID) != nil {
			continue
		}
		operatorID, portID, ok := portOfURI(r.Port)
		if !ok {
			continue
		}
		namespace, table := executionNamespace(exec.RID), r.Table
		if i := strings.LastIndex(table, "."); i >= 0 {
			namespace, table = table[:i], table[i+1:]
		}
		warehouse := s.warehouseOf(ctx, exec)
		// One row through the unit that will read it: the columns, and proof it can.
		page, err := client.Result(ctx, exec.RID.String(), operatorID, portID, table, namespace, warehouse, 0, 1)
		if err != nil || len(page.Schema) == 0 {
			continue
		}
		return &storedRows{From: r.Port, Execution: exec.RID, Warehouse: warehouse, Namespace: namespace, Table: table, Columns: page.Schema}
	}
	return nil
}

// portOfURI reads the operator and port from a port's URI.
func portOfURI(port string) (operatorID, portID string, ok bool) {
	parts := strings.Split(port, "/")
	n := len(parts)
	if n < 4 || parts[n-4] != "operators" || parts[n-2] != "ports" {
		return "", "", false
	}
	return parts[n-3], parts[n-1], true
}

// reusedRecord says what an execution read from earlier runs, in the order of its plan.
func reusedRecord(served map[string]*storedRows) []api.ReusedResult {
	var out []api.ReusedResult
	for key, rows := range served {
		i := strings.LastIndex(key, "/")
		out = append(out, api.ReusedResult{OperatorID: key[:i], PortID: key[i+1:], From: api.Uri(rows.From)})
	}
	sort.Slice(out, func(a, b int) bool {
		return out[a].OperatorID+"/"+out[a].PortID < out[b].OperatorID+"/"+out[b].PortID
	})
	return out
}

// reusedEdges are the arrows from each port a run served from storage to the earlier port whose
// rows it read.
func reusedEdges(exec *store.Resource, execURI string, served map[string]*storedRows) []store.Edge {
	var edges []store.Edge
	execRID := exec.RID
	for _, r := range reusedRecord(served) {
		to := served[portKey(r.OperatorID, r.PortID)]
		toRID := to.Execution
		edges = append(edges, store.Edge{
			From: execURI + "/operators/" + r.OperatorID + "/ports/" + r.PortID, Relation: "reused", To: to.From,
			FromRID: exec.RID, ToRID: &toRID, ExecutionRID: &execRID,
		})
	}
	return edges
}
