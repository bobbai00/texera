package catalog

// The lineage graph a person reads, the same beside a chat and on a resource's page: the
// resources in it, each with the versions of it that took part; the executions of those
// versions, each with the version it ran, the unit it ran on and the results it kept; an arrow
// from each dataset, model and function version a workflow version reads or uses to that
// version, joining the file to each operator that names it; and an arrow from an execution to
// each dataset version that keeps one of its results, joining the port to the file. An arrow
// into a workflow version is executed once an execution of the version ran an operator that
// names its source, or reused that operator's rows; else the version only names it. A
// workflow's versions on the graph are those executed and its newest: a version saved on the
// way and never executed made nothing. It is computed from what the catalog records: the
// executions' specs and statuses, what each version's content names, and the lineage of the
// versions that keep results.

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// mostExecutions is how many executions of one version the graph lists, the newest; it counts
// the others.
const mostExecutions = 3

// roleOf is what a resource stands for on the graph; "" for a kind the graph does not draw.
func roleOf(r *store.Resource) api.GraphRole {
	switch r.Kind {
	case "dataset":
		return api.GraphRoleData
	case "workflow":
		return api.GraphRoleWorkflow
	case "model":
		return api.GraphRoleModel
	case "operator":
		var spec api.OperatorSpec
		if json.Unmarshal(r.Spec, &spec) == nil && spec.Implementation != nil {
			return api.GraphRoleFunction
		}
	}
	return ""
}

// graphBuilder gathers a graph: each resource once with its versions, each execution once, each
// arrow once, in the order they were found.
type graphBuilder struct {
	s      *Service
	ctx    context.Context
	caller *auth.Caller
	// The chat whose graph it is; nil on a resource's page.
	chat *uuid.UUID

	nodes []*api.GraphNode
	byURI map[string]*api.GraphNode
	// What a name the graph met named, when it is gone or of a kind the graph does not draw.
	gone map[string]bool
	// Each node's versions on the graph, by number, and each workflow's newest.
	versions map[string]map[int]*api.GraphVersion
	heads    map[string]int
	// The version a node shows when nothing on the graph reads, uses or ran one of it.
	fallback map[string]int
	// The versions the chat made, as `<uri>@<vno>`.
	madeVersions map[string]bool

	executions []api.GraphExecution
	listed     map[string]bool
	results    []api.GraphResult
	edges      []api.GraphEdge
	edgeAt     map[string]int
	units      map[string]*api.GraphUnit
	specs      map[string]*api.WorkflowSpec
	// When the chat first made or ran each node, and the executions it started.
	touched map[string]time.Time
	ran     []chatRun
}

// chatRun is an execution a chat started: of which workflow, in which turn.
type chatRun struct {
	workflow string
	turn     string
}

func (s *Service) newGraph(ctx context.Context, caller *auth.Caller, chat *uuid.UUID) *graphBuilder {
	return &graphBuilder{
		s: s, ctx: ctx, caller: caller, chat: chat,
		byURI: map[string]*api.GraphNode{}, gone: map[string]bool{},
		versions: map[string]map[int]*api.GraphVersion{}, heads: map[string]int{}, fallback: map[string]int{}, madeVersions: map[string]bool{},
		listed: map[string]bool{}, edgeAt: map[string]int{}, units: map[string]*api.GraphUnit{},
		specs: map[string]*api.WorkflowSpec{}, touched: map[string]time.Time{},
	}
}

func (g *graphBuilder) touch(node string, at time.Time) {
	if was, ok := g.touched[node]; !ok || at.Before(was) {
		g.touched[node] = at
	}
}

// inChat tells whether something was made in the chat whose graph this is.
func (g *graphBuilder) inChat(o *store.Origin) bool {
	return g.chat != nil && o != nil && o.Conversation == *g.chat
}

// add puts a resource the caller may read on the graph, once; nil for a kind it does not draw.
func (g *graphBuilder) add(r *store.Resource) *api.GraphNode {
	u := URI(r).String()
	if n := g.byURI[u]; n != nil {
		return n
	}
	role := roleOf(r)
	if role == "" {
		return nil
	}
	n := &api.GraphNode{Uri: api.Uri(u), Role: role, Kind: api.ResourceKind(r.Kind), Name: r.Name, Description: r.Description, Readable: true}
	if g.inChat(r.Origin) {
		turn := r.Origin.Turn
		n.Turn = &turn
		n.Made = true
		g.touch(u, r.CreatedAt)
	}
	g.nodes = append(g.nodes, n)
	g.byURI[u] = n
	g.heads[u] = r.HeadVno
	return n
}

// named is the node of the resource a name names, read as the caller. One they may not read
// stands where it is named, without its name; nil for one that is gone, or of a kind the graph
// does not draw.
func (g *graphBuilder) named(ref uri.Ref) *api.GraphNode {
	u := ref.Resource().String()
	if n := g.byURI[u]; n != nil {
		return n
	}
	if g.gone[u] {
		return nil
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		g.gone[u] = true
		return nil
	}
	r, err := g.s.Get(g.ctx, g.caller, &ref.Kind, rid)
	if err == nil {
		if n := g.add(r); n != nil {
			return n
		}
		g.gone[u] = true
		return nil
	}
	var refused *Error
	if !errors.As(err, &refused) || refused.Code != "forbidden" {
		g.gone[u] = true
		return nil
	}
	// What it stands for is plain from where it is named; nothing else of it is said.
	row, err := g.s.Store.GetResource(g.ctx, rid)
	role := api.GraphRole("")
	if err == nil {
		role = roleOf(row)
	}
	if role == "" {
		g.gone[u] = true
		return nil
	}
	n := &api.GraphNode{Uri: api.Uri(u), Role: role, Kind: api.ResourceKind(ref.Kind.Name)}
	g.nodes = append(g.nodes, n)
	g.byURI[u] = n
	return n
}

// version is a version of a node on the graph, put there the first time it is asked for.
func (g *graphBuilder) version(n *api.GraphNode, vno int) *api.GraphVersion {
	u := string(n.Uri)
	if g.versions[u] == nil {
		g.versions[u] = map[int]*api.GraphVersion{}
	}
	v := g.versions[u][vno]
	if v == nil {
		v = &api.GraphVersion{Vno: api.Vno(vno)}
		g.versions[u][vno] = v
	}
	return v
}

// execution puts an execution on the graph, hung off the version of the workflow it ran, with
// what it read, the unit it ran on and the results it kept. It is left out when it names no
// version or its workflow is not the caller's to read.
func (g *graphBuilder) execution(x *store.Resource) {
	u := URI(x).String()
	if g.listed[u] {
		return
	}
	var spec api.ExecutionSpec
	var status api.ExecutionStatus
	if json.Unmarshal(x.Spec, &spec) != nil {
		return
	}
	_ = json.Unmarshal(x.Status, &status)
	ran, err := uri.Parse(string(spec.Workflow))
	if err != nil || ran.Vno == 0 {
		return
	}
	wf := g.named(ran)
	if wf == nil || wf.Role != api.GraphRoleWorkflow || !wf.Readable {
		return
	}
	g.listed[u] = true
	g.version(wf, ran.Vno)
	out := api.GraphExecution{
		Uri: api.Uri(u), Workflow: wf.Uri, Version: api.Vno(ran.Vno), Name: x.Name, Phase: string(status.Phase),
		Steps: int32(planSteps(spec)), StartedAt: status.StartedAt, FinishedAt: status.FinishedAt,
	}
	if spec.Reused != nil {
		out.Reused = int32(len(*spec.Reused))
	}
	if unit := string(spec.ComputingUnit); unit != "" {
		out.Unit = g.unit(unit)
	}
	if spec.Computing != nil {
		out.Profile = spec.Computing.Profile
	}
	if spec.Warehouse != "" {
		out.Warehouse = &spec.Warehouse
	}
	out.CreatedBy, out.Origin = api.Pid(x.CreatedByPID.String()), originOf(x.Origin)
	if g.inChat(x.Origin) {
		out.Made = true
		g.ran = append(g.ran, chatRun{workflow: wf.Name, turn: x.Origin.Turn})
	}
	g.touch(string(wf.Uri), x.CreatedAt)
	g.executions = append(g.executions, out)

	// What it read and called: what the operators it ran name, and those it read an earlier
	// execution's rows for instead, whose rows came of the same. An execution whose plan says
	// neither ran them all.
	version := ran.Resource().WithVersion(ran.Vno).String()
	operators := g.spec(version)
	ranOps := planOperators(spec)
	g.names(version, func(id string) bool { return len(ranOps) == 0 || ranOps[id] })
	// What it shows of what it kept; what it keeps only to reuse is no result.
	if status.Ports == nil || status.ResultsExpiredAt != nil {
		return
	}
	for _, p := range *status.Ports {
		if p.Table == nil || strings.HasPrefix(*p.Table, "vfs:") || !shownPort(spec, p.OperatorID, p.PortID) {
			continue
		}
		result := api.GraphResult{Uri: api.Uri(u + "/operators/" + p.OperatorID + "/ports/" + p.PortID), Execution: api.Uri(u), Operator: p.OperatorID, Rows: p.Rows}
		if operators != nil {
			for _, op := range operators.Operators {
				if op.OperatorID == p.OperatorID {
					result.OperatorType, result.DisplayName = op.OperatorType, op.CustomDisplayName
				}
			}
		}
		g.results = append(g.results, result)
	}
}

// names draws what the operators of a workflow version name: an arrow from each version they
// read or use, joining it to each operator. ran tells whether an execution of the version ran
// an operator, or read an earlier execution's rows of it instead.
func (g *graphBuilder) names(version string, ran func(operatorID string) bool) {
	spec := g.spec(version)
	if spec == nil {
		return
	}
	for _, op := range spec.Operators {
		executed := ran(op.OperatorID)
		if ref, err := uri.Parse(op.OperatorType); err == nil {
			g.arrow(ref, version, op, executed)
		}
		for _, ref := range uri.Extract(map[string]any(op.OperatorProperties)) {
			g.arrow(ref, version, op, executed)
		}
	}
}

// arrow draws what an operator of a workflow version reads or uses: a file of a dataset or a
// model, a model, or a function, at a version.
func (g *graphBuilder) arrow(ref uri.Ref, version string, op api.WorkflowOperator, executed bool) {
	relation := api.GraphEdgeRelationUses
	switch ref.Kind.Name {
	case "dataset":
		relation = api.GraphEdgeRelationReads
	case "model", "operator":
	default:
		return
	}
	if ref.Vno == 0 {
		return
	}
	n := g.named(ref)
	if n == nil || (ref.Kind.Name == "operator" && n.Role != api.GraphRoleFunction) {
		return
	}
	g.version(n, ref.Vno)
	part := api.GraphPart{To: ptr("operators/" + op.OperatorID), OperatorType: ptr(op.OperatorType), DisplayName: op.CustomDisplayName, Executed: executed}
	if ref.Subresource != "" {
		part.From = ptr(ref.Subresource)
	}
	g.join(ref.Resource().WithVersion(ref.Vno).String(), version, relation, part)
}

// keeps draws the dataset versions that keep a result of an execution on the graph: an arrow
// from the execution to each, joining the port to the file.
func (g *graphBuilder) keeps(x api.GraphExecution) error {
	at := string(x.Uri)
	derived, err := g.s.Store.EdgesTo(g.ctx, at, []string{"derivedFrom"})
	if err != nil {
		return err
	}
	operators := g.spec(string(x.Workflow) + "@" + strconv.Itoa(int(x.Version)))
	for _, e := range derived {
		ref, err := uri.Parse(e.From)
		port, isPort := strings.CutPrefix(e.To, at+"/")
		if err != nil || ref.Kind.Name != "dataset" || ref.Vno == 0 || !isPort {
			continue
		}
		n := g.named(ref)
		if n == nil {
			continue
		}
		g.version(n, ref.Vno)
		part := api.GraphPart{From: ptr(port), Executed: true}
		if ref.Subresource != "" {
			part.To = ptr(ref.Subresource)
		}
		if op := operatorOf(operators, port); op != nil {
			part.OperatorType, part.DisplayName = ptr(op.OperatorType), op.CustomDisplayName
		}
		g.join(at, ref.Resource().WithVersion(ref.Vno).String(), api.GraphEdgeRelationKeeps, part)
	}
	return nil
}

// operatorOf is the operator of a workflow version a port of its execution is of; nil when
// the version is not at hand or has no such operator.
func operatorOf(spec *api.WorkflowSpec, port string) *api.WorkflowOperator {
	id, _, _ := strings.Cut(strings.TrimPrefix(port, "operators/"), "/")
	if spec == nil {
		return nil
	}
	for i := range spec.Operators {
		if spec.Operators[i].OperatorID == id {
			return &spec.Operators[i]
		}
	}
	return nil
}

// join puts an arrow between two versions on the graph once, with each part it joins once; an
// arrow or a part is executed once any execution executed it.
func (g *graphBuilder) join(from, to string, relation api.GraphEdgeRelation, part api.GraphPart) {
	key := from + "|" + to
	i, ok := g.edgeAt[key]
	if !ok {
		i = len(g.edges)
		g.edgeAt[key] = i
		g.edges = append(g.edges, api.GraphEdge{From: api.Uri(from), To: api.Uri(to), Relation: relation, Parts: []api.GraphPart{}})
	}
	e := &g.edges[i]
	e.Executed = e.Executed || part.Executed
	for j := range e.Parts {
		if samePtr(e.Parts[j].From, part.From) && samePtr(e.Parts[j].To, part.To) {
			e.Parts[j].Executed = e.Parts[j].Executed || part.Executed
			return
		}
	}
	e.Parts = append(e.Parts, part)
}

func samePtr(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// unit is the unit an execution ran on, as a label of it, when the caller may read it.
func (g *graphBuilder) unit(name string) *api.GraphUnit {
	if u, ok := g.units[name]; ok {
		return u
	}
	var out *api.GraphUnit
	if r, err := g.s.resourceByURI(g.ctx, g.caller, name, &unitKind); err == nil {
		out = &api.GraphUnit{Uri: api.Uri(name), Name: r.Name, State: unitPhase(r)}
		var spec api.ComputingUnitSpec
		if json.Unmarshal(r.Spec, &spec) == nil {
			if node := masterOf(&spec); node != nil {
				out.Cpu, out.Memory, out.Gpu = node.Cpu, node.Memory, node.Gpu
			}
		}
	}
	g.units[name] = out
	return out
}

// spec is a workflow version's content; nil when it cannot be read.
func (g *graphBuilder) spec(version string) *api.WorkflowSpec {
	if s, ok := g.specs[version]; ok {
		return s
	}
	var out *api.WorkflowSpec
	if ref, err := uri.Parse(version); err == nil {
		if id, err := uuid.Parse(ref.Rid); err == nil {
			if v, err := g.s.Store.GetVersion(g.ctx, id, ref.Vno); err == nil {
				var spec api.WorkflowSpec
				if json.Unmarshal(v.Content, &spec) == nil {
					out = &spec
				}
			}
		}
	}
	g.specs[version] = out
	return out
}

// otherwise names the version a node shows when nothing on the graph reads, uses or ran one
// of it: its newest.
func (g *graphBuilder) otherwise(n *api.GraphNode, vno int) {
	if n != nil && vno > 0 {
		g.fallback[string(n.Uri)] = vno
	}
}

// done is the graph: what each workflow version on it names, its executions the newest first
// and at most mostExecutions of each version, the dataset versions that keep their results,
// each resource's versions the newest first, and a resource nothing reads, uses, ran or keeps
// at the version it shows otherwise.
func (g *graphBuilder) done() (*api.ResourceGraph, error) {
	var flows []string
	for _, n := range g.nodes {
		if n.Role == api.GraphRoleWorkflow {
			for vno := range g.versions[string(n.Uri)] {
				flows = append(flows, string(n.Uri)+"@"+strconv.Itoa(vno))
			}
		}
	}
	slices.Sort(flows)
	for _, version := range flows {
		g.names(version, func(string) bool { return false })
	}

	out := &api.ResourceGraph{
		Nodes: make([]api.GraphNode, 0, len(g.nodes)), Executions: []api.GraphExecution{}, Results: []api.GraphResult{},
		Planned: []api.PlannedItem{}, Sources: []api.GraphSource{}, Units: []api.GraphUnit{},
	}
	// The executions came in the order they were found; the newest first, a few of each version.
	slices.SortStableFunc(g.executions, func(a, b api.GraphExecution) int { return startOf(b).Compare(startOf(a)) })
	kept := map[string]bool{}
	for _, x := range g.executions {
		n := g.byURI[string(x.Workflow)]
		v := g.version(n, int(x.Version))
		count := int32(0)
		if v.Executions != nil {
			count = *v.Executions
		}
		count++
		v.Executions = &count
		if count <= mostExecutions {
			out.Executions = append(out.Executions, x)
			kept[string(x.Uri)] = true
		}
	}
	for _, x := range out.Executions {
		if err := g.keeps(x); err != nil {
			return nil, err
		}
	}
	for _, r := range g.results {
		if kept[string(r.Execution)] {
			out.Results = append(out.Results, r)
		}
	}
	out.Edges = g.edges
	if out.Edges == nil {
		out.Edges = []api.GraphEdge{}
	}
	for _, n := range g.nodes {
		if vno := g.fallback[string(n.Uri)]; vno > 0 && len(g.versions[string(n.Uri)]) == 0 {
			g.version(n, vno)
		}
	}
	// Who made each version the caller may read of.
	var keys []store.VersionKey
	for _, n := range g.nodes {
		ref, err := uri.Parse(string(n.Uri))
		id, perr := uuid.Parse(ref.Rid)
		if err != nil || perr != nil || !n.Readable {
			continue
		}
		for vno := range g.versions[string(n.Uri)] {
			keys = append(keys, store.VersionKey{RID: id, Vno: vno})
		}
	}
	made, err := g.s.Store.VersionSummaries(g.ctx, keys)
	if err != nil {
		return nil, err
	}
	for _, v := range made {
		for _, n := range g.nodes {
			if ref, err := uri.Parse(string(n.Uri)); err == nil && ref.Rid == v.RID.String() {
				if at := g.versions[string(n.Uri)][v.Vno]; at != nil {
					pid := api.Pid(v.CreatedByPID.String())
					at.CreatedBy, at.Origin = &pid, originOf(v.Origin)
				}
			}
		}
	}
	for _, n := range g.nodes {
		for _, v := range g.versions[string(n.Uri)] {
			v.Made = g.madeVersions[string(n.Uri)+"@"+strconv.Itoa(int(v.Vno))]
			n.Versions = append(n.Versions, *v)
		}
		slices.SortFunc(n.Versions, func(a, b api.GraphVersion) int { return int(b.Vno) - int(a.Vno) })
		if n.Versions == nil {
			n.Versions = []api.GraphVersion{}
		}
		out.Nodes = append(out.Nodes, *n)
	}
	return out, nil
}

func ptr[T any](v T) *T { return &v }

// ranVersion is the version of its workflow an execution ran; 0 when it names none.
func ranVersion(x *store.Resource) int {
	var spec api.ExecutionSpec
	if json.Unmarshal(x.Spec, &spec) != nil {
		return 0
	}
	ref, err := uri.Parse(string(spec.Workflow))
	if err != nil {
		return 0
	}
	return ref.Vno
}

// startOf is when an execution started: one not started yet is the newest of all.
func startOf(x api.GraphExecution) time.Time {
	if x.StartedAt == nil {
		return time.Unix(1<<40, 0)
	}
	return *x.StartedAt
}

// ResourceGraph is the lineage graph of a resource, as the caller may see it: for a workflow,
// its executions and its newest version; for an execution, itself; for a dataset, a model or a
// function, the executions whose results its versions keep, the executions of the workflow
// versions that name it, and the newest version of each workflow that names it. Each workflow
// version on it shows all it reads and uses. Any other kind has none.
func (s *Service) ResourceGraph(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*api.ResourceGraph, error) {
	r, err := s.Get(ctx, caller, nil, rid)
	if err != nil {
		return nil, err
	}
	g := s.newGraph(ctx, caller, nil)
	// The executions a filter lists; of the versions given, when versions are given.
	executionsOf := func(filter store.ResourceFilter, of map[int]bool) error {
		filter.Kind, filter.ReadableBy, filter.Limit = "execution", readableBy(caller), listLimit
		xs, err := s.Store.ListResources(ctx, filter)
		if err != nil {
			return err
		}
		for i := range xs {
			if of == nil || of[ranVersion(&xs[i])] {
				g.execution(&xs[i])
			}
		}
		return nil
	}
	// The workflow versions whose content names the resource, each once.
	namers := func(of string) ([]uri.Ref, error) {
		edges, err := s.Store.EdgesTo(ctx, of, []string{"references"})
		if err != nil {
			return nil, err
		}
		var out []uri.Ref
		for _, e := range edges {
			if ref, err := uri.Parse(e.From); err == nil && ref.Kind.Name == "workflow" && ref.Vno > 0 &&
				!slices.ContainsFunc(out, func(had uri.Ref) bool { return had.String() == ref.String() }) {
				out = append(out, ref)
			}
		}
		return out, nil
	}
	whole := URI(r).String()
	switch r.Kind {
	case "workflow":
		n := g.add(r)
		if err := executionsOf(store.ResourceFilter{ParentRID: &r.RID}, nil); err != nil {
			return nil, err
		}
		if r.HeadVno > 0 {
			g.version(n, r.HeadVno)
		}
	case "execution":
		g.execution(r)
	case "dataset", "model", "operator":
		n := g.add(r)
		if n == nil {
			break
		}
		// The executions whose results its versions keep, with what they ran.
		derived, err := s.Store.EdgesFrom(ctx, whole, []string{"derivedFrom"})
		if err != nil {
			return nil, err
		}
		for _, e := range derived {
			if x := s.keptFrom(ctx, caller, e.To); x != nil {
				g.execution(x)
			}
		}
		refs, err := namers(whole)
		if err != nil {
			return nil, err
		}
		// Each workflow once, with the versions of it that name the resource.
		var flows []uri.Ref
		naming := map[string]map[int]bool{}
		for _, ref := range refs {
			if naming[ref.Rid] == nil {
				naming[ref.Rid] = map[int]bool{}
				flows = append(flows, ref)
			}
			naming[ref.Rid][ref.Vno] = true
		}
		for _, ref := range flows {
			wf := g.named(ref)
			parent, err := uuid.Parse(ref.Rid)
			if wf == nil || !wf.Readable || err != nil {
				continue
			}
			if err := executionsOf(store.ResourceFilter{ParentRID: &parent}, naming[ref.Rid]); err != nil {
				return nil, err
			}
			if head := g.heads[string(wf.Uri)]; naming[ref.Rid][head] {
				g.version(wf, head)
			}
		}
		g.otherwise(n, r.HeadVno)
	}
	return g.done()
}

// keptFrom is the execution a port of it names, when the caller may read it; nil otherwise.
func (s *Service) keptFrom(ctx context.Context, caller *auth.Caller, port string) *store.Resource {
	ref, err := uri.Parse(port)
	if err != nil || ref.Kind.Name != "execution" {
		return nil
	}
	workflow, werr := uuid.Parse(ref.Parent)
	eid, eerr := uuid.Parse(ref.Rid)
	if werr != nil || eerr != nil {
		return nil
	}
	x, err := s.Execution(ctx, caller, workflow, eid)
	if err != nil {
		return nil
	}
	return x
}

// workflowsInOrder puts the workflows in the order the chat first made or ran them, each in a
// place a workflow held, so a workflow the chat comes to later never comes before one drawn. A
// workflow it only worked from, and never ran, comes last.
func (g *graphBuilder) workflowsInOrder() {
	var at []int
	var flows []*api.GraphNode
	for i, n := range g.nodes {
		if n.Role == api.GraphRoleWorkflow {
			at = append(at, i)
			flows = append(flows, n)
		}
	}
	slices.SortStableFunc(flows, func(a, b *api.GraphNode) int {
		ta, oka := g.touched[string(a.Uri)]
		tb, okb := g.touched[string(b.Uri)]
		switch {
		case oka && okb:
			return ta.Compare(tb)
		case oka:
			return -1
		case okb:
			return 1
		}
		return 0
	})
	for j, i := range at {
		g.nodes[i] = flows[j]
	}
}

// unitPhase is how a unit stands, as its status says: starting, ready, and so on.
func unitPhase(r *store.Resource) *string {
	var us api.ComputingUnitStatus
	if json.Unmarshal(r.Status, &us) != nil || us.Phase == "" {
		return nil
	}
	phase := string(us.Phase)
	return &phase
}

// planSteps are the operators of the workflow an execution ran: those in its plan and those it
// skipped.
func planSteps(spec api.ExecutionSpec) int {
	n := 0
	if spec.Plan != nil {
		if plan, ok := spec.Plan.LogicalPlan.(map[string]any); ok {
			if ops, ok := plan["operators"].([]any); ok {
				n = len(ops)
			}
		}
	}
	if spec.Skipped != nil {
		n += len(*spec.Skipped)
	}
	return n
}

// planOperators are the operators an execution ran: those in its plan, and those it read an
// earlier execution's rows for instead.
func planOperators(spec api.ExecutionSpec) map[string]bool {
	out := map[string]bool{}
	if spec.Plan != nil {
		if plan, ok := spec.Plan.LogicalPlan.(map[string]any); ok {
			if ops, ok := plan["operators"].([]any); ok {
				for _, op := range ops {
					if m, ok := op.(map[string]any); ok {
						if id, ok := m["operatorID"].(string); ok {
							out[id] = true
						}
					}
				}
			}
		}
	}
	if spec.Skipped != nil {
		for _, id := range *spec.Skipped {
			out[id] = true
		}
	}
	return out
}

// shownPort tells whether an execution shows a port's rows rather than keeping them only for
// reuse; an execution of an earlier release, whose plan says neither, shows all it kept.
func shownPort(spec api.ExecutionSpec, operatorID, portID string) bool {
	if spec.Plan == nil {
		return true
	}
	// A plan that marks the ports it shows marks every one of them.
	marks := slices.ContainsFunc(spec.Plan.Outputs, func(o api.PortTable) bool { return o.Shown != nil })
	for _, o := range spec.Plan.Outputs {
		if o.OperatorID == operatorID && o.PortID == portID {
			return !marks || (o.Shown != nil && *o.Shown)
		}
	}
	return !marks
}
