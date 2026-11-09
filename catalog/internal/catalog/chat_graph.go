package catalog

// The resource graph beside a chat: what it read, made and ran, and how they connect. It is
// computed from what the catalog records already: what the chat made and worked from, its
// executions (what each read, the unit it ran on, the tables it kept), the custom operators its
// workflows name, and what its start_work calls said it would make.

import (
	"context"
	"encoding/json"
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
	case "computing-unit":
		return api.GraphRoleUnit
	}
	return ""
}

// chatGraph gathers a graph's nodes and edges, each once, in the order they were found.
type chatGraph struct {
	nodes []*api.GraphNode
	byURI map[string]*api.GraphNode
	edges []api.GraphEdge
	seen  map[api.GraphEdge]bool
	// When the chat first made or ran each node, where it did.
	touched map[string]time.Time
}

func (g *chatGraph) touch(node string, at time.Time) {
	if was, ok := g.touched[node]; !ok || at.Before(was) {
		g.touched[node] = at
	}
}

// workflowsInOrder puts the workflows in the order the chat first made or ran them, each in a
// place a workflow held, so a workflow the chat comes to later never comes before one drawn.
// A workflow it only worked from, and never ran, comes last.
func (g *chatGraph) workflowsInOrder() {
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

// chatRun is a run the chat started: of which workflow, in which turn.
type chatRun struct {
	workflow string
	turn     string
}

func (g *chatGraph) node(n api.GraphNode) *api.GraphNode {
	if have := g.byURI[string(n.Uri)]; have != nil {
		have.Made = have.Made || n.Made
		return have
	}
	g.nodes = append(g.nodes, &n)
	g.byURI[string(n.Uri)] = &n
	return &n
}

func (g *chatGraph) edge(from, to string, relation api.GraphEdgeRelation) {
	e := api.GraphEdge{From: api.Uri(from), To: api.Uri(to), Relation: relation}
	if from == "" || to == "" || g.seen[e] || g.byURI[from] == nil || g.byURI[to] == nil {
		return
	}
	g.seen[e] = true
	g.edges = append(g.edges, e)
}

// ConversationGraph is the resource graph of a chat, as the caller may see it.
func (s *Service) ConversationGraph(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*api.ConversationGraph, error) {
	items, err := s.ConversationResources(ctx, caller, rid)
	if err != nil {
		return nil, err
	}
	g := &chatGraph{byURI: map[string]*api.GraphNode{}, seen: map[api.GraphEdge]bool{}, touched: map[string]time.Time{}}
	var executions []*store.Resource
	// The version each workflow shows: the one its newest run ran, else the one the chat has.
	shown := map[string]string{}
	workflows := map[string]*store.Resource{}
	for i := range items {
		item := &items[i]
		r := &item.Resource
		if r.Kind == "execution" {
			executions = append(executions, r)
			continue
		}
		role := roleOf(r)
		if role == "" {
			continue
		}
		n := api.GraphNode{Uri: api.Uri(URI(r).String()), Role: role, Kind: api.ResourceKind(r.Kind), Name: r.Name, Made: item.Made, Description: r.Description}
		if role == api.GraphRoleUnit {
			n.State = unitPhase(r)
			sizeUnitNode(&n, r)
		}
		if r.Origin != nil && r.Origin.Conversation == rid {
			turn := r.Origin.Turn
			n.Turn = &turn
			g.touch(string(n.Uri), r.CreatedAt)
		}
		if len(item.Versions) > 0 {
			v := api.Vno(item.Versions[0].Vno)
			n.Version = &v
		}
		for _, v := range item.Versions {
			if v.Made {
				g.touch(string(n.Uri), v.CreatedAt)
			}
		}
		g.node(n)
		if r.Kind == "workflow" {
			workflows[string(n.Uri)] = r
			if n.Version != nil {
				shown[string(n.Uri)] = URI(r).WithVersion(int(*n.Version)).String()
			}
		}
	}

	// Each execution, the newest first: what it read, where it ran, what it kept.
	slices.SortStableFunc(executions, func(a, b *store.Resource) int { return b.CreatedAt.Compare(a.CreatedAt) })
	ranVersion := map[string]bool{}
	var runs []chatRun
	for _, exec := range executions {
		var spec api.ExecutionSpec
		var status api.ExecutionStatus
		if json.Unmarshal(exec.Spec, &spec) != nil {
			continue
		}
		_ = json.Unmarshal(exec.Status, &status)
		wfRef, err := uri.Parse(string(spec.Workflow))
		if err != nil {
			continue
		}
		workflow := uri.Of(wfRef.Kind, wfRef.Rid).String()
		wfNode := g.byURI[workflow]
		if wfNode == nil {
			continue
		}
		g.touch(workflow, exec.CreatedAt)
		if exec.Origin != nil && exec.Origin.Conversation == rid {
			runs = append(runs, chatRun{workflow: wfNode.Name, turn: exec.Origin.Turn})
		}
		if !ranVersion[workflow] {
			ranVersion[workflow] = true
			shown[workflow] = string(spec.Workflow)
		}
		run := api.GraphRun{Uri: api.Uri(URI(exec).String()), Phase: string(status.Phase), Steps: int32(planSteps(spec))}
		if wfRef.Vno > 0 {
			version := api.Vno(wfRef.Vno)
			run.Version = &version
		}
		if spec.Reused != nil {
			run.Reused = int32(len(*spec.Reused))
		}
		run.StartedAt, run.FinishedAt = status.StartedAt, status.FinishedAt
		// Where it ran: the unit, drawn when the caller may see it.
		if unit := string(spec.ComputingUnit); unit != "" && s.unitNode(ctx, caller, g, unit) {
			g.edge(workflow, unit, api.GraphEdgeRelationRunsOn)
			on := api.Uri(unit)
			run.Unit = &on
		}
		listed := []api.GraphRun{}
		if wfNode.Runs != nil {
			listed = *wfNode.Runs
		}
		listed = append(listed, run)
		wfNode.Runs = &listed
		if wfNode.State == nil {
			phase := string(status.Phase)
			wfNode.State = &phase
		}
		if spec.Inputs != nil {
			for _, in := range *spec.Inputs {
				ref, err := uri.Parse(string(in))
				if err != nil {
					continue
				}
				base := uri.Of(ref.Kind, ref.Rid).String()
				switch ref.Kind.Name {
				case "dataset":
					g.edge(base, workflow, api.GraphEdgeRelationReads)
				case "model":
					g.edge(base, workflow, api.GraphEdgeRelationUses)
				}
			}
		}
		if status.Ports == nil || status.ResultsExpiredAt != nil {
			continue
		}
		for _, p := range *status.Ports {
			// What the run shows is what it made; what it keeps only to reuse is not drawn.
			if p.Table == nil || strings.HasPrefix(*p.Table, "vfs:") || !shownPort(spec, p.OperatorID, p.PortID) {
				continue
			}
			port := URI(exec).String() + "/operators/" + p.OperatorID + "/ports/" + p.PortID
			n := g.node(api.GraphNode{Uri: api.Uri(port), Role: api.GraphRoleData, Kind: api.ResourceKind("execution"), Name: p.OperatorID, Made: true})
			step := p.OperatorID
			n.Step = &step
			n.Rows = p.Rows
			by := api.Uri(URI(exec).String())
			n.Run = &by
			g.edge(workflow, port, api.GraphEdgeRelationMakes)
		}
	}

	// What each workflow's version is made of, and what it names: the functions and models it
	// uses, and the data it reads, which for a workflow that has not run is what it will read.
	byVersion := map[string]string{}
	var sources []string
	for _, n := range g.nodes {
		version := shown[string(n.Uri)]
		if n.Role != api.GraphRoleWorkflow || version == "" {
			continue
		}
		byVersion[version] = string(n.Uri)
		sources = append(sources, version)
		if steps := s.stepsOf(ctx, version); steps != nil {
			n.Steps = &steps
		}
	}
	refs, err := s.Store.ReferencesFrom(ctx, sources)
	if err != nil {
		return nil, err
	}
	for _, e := range refs {
		workflow := byVersion[e.From]
		ref, err := uri.Parse(e.To)
		if workflow == "" || err != nil {
			continue
		}
		target := uri.Of(ref.Kind, ref.Rid).String()
		relation := api.GraphEdgeRelationUses
		switch ref.Kind.Name {
		case "dataset":
			relation = api.GraphEdgeRelationReads
		case "operator", "model":
		default:
			continue
		}
		if g.byURI[target] == nil {
			r, err := s.resourceByURI(ctx, caller, target, nil)
			if err != nil || roleOf(r) == "" {
				continue
			}
			n := api.GraphNode{Uri: api.Uri(target), Role: roleOf(r), Kind: api.ResourceKind(r.Kind), Name: r.Name, Description: r.Description}
			if ref.Vno > 0 {
				v := api.Vno(ref.Vno)
				n.Version = &v
			}
			g.node(n)
		}
		g.edge(target, workflow, relation)
	}
	// A workflow that has not run will run on its default unit.
	for _, n := range g.nodes {
		r := workflows[string(n.Uri)]
		if r == nil || n.Runs != nil {
			continue
		}
		var spec api.WorkflowSpec
		if json.Unmarshal(r.Spec, &spec) != nil || spec.DefaultComputingUnit == nil {
			continue
		}
		ref, err := uri.Parse(string(*spec.DefaultComputingUnit))
		if err != nil {
			continue
		}
		unit := uri.Of(ref.Kind, ref.Rid).String()
		if s.unitNode(ctx, caller, g, unit) {
			g.edge(string(n.Uri), unit, api.GraphEdgeRelationRunsOn)
		}
	}
	g.workflowsInOrder()

	said, err := s.chatSaid(ctx, rid)
	if err != nil {
		return nil, err
	}
	out := &api.ConversationGraph{
		Nodes:   make([]api.GraphNode, 0, len(g.nodes)),
		Edges:   g.edges,
		Planned: said.notMade(g, runs),
		Sources: s.consulted(ctx, caller, said),
	}
	if out.Edges == nil {
		out.Edges = []api.GraphEdge{}
	}
	for _, n := range g.nodes {
		out.Nodes = append(out.Nodes, *n)
	}
	return out, nil
}

// unitNode puts a computing unit the caller may read on the graph, with its phase, and says
// whether it is there.
func (s *Service) unitNode(ctx context.Context, caller *auth.Caller, g *chatGraph, unit string) bool {
	if g.byURI[unit] != nil {
		return true
	}
	r, err := s.resourceByURI(ctx, caller, unit, &unitKind)
	if err != nil {
		return false
	}
	n := api.GraphNode{Uri: api.Uri(unit), Role: api.GraphRoleUnit, Kind: api.ResourceKind(r.Kind), Name: r.Name, Description: r.Description, State: unitPhase(r)}
	sizeUnitNode(&n, r)
	g.node(n)
	return true
}

// sizeUnitNode says on a unit's node what its main node has.
func sizeUnitNode(n *api.GraphNode, r *store.Resource) {
	var spec api.ComputingUnitSpec
	if json.Unmarshal(r.Spec, &spec) != nil || spec.ComputingNodes == nil {
		return
	}
	for _, node := range *spec.ComputingNodes {
		if node.Role == api.ComputingNodeSpecRoleMaster {
			n.Cpu, n.Memory, n.Gpu = node.Cpu, node.Memory, node.Gpu
			return
		}
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

// stepsOf is a workflow version's operators as steps, each after the steps it reads; nil when
// the version cannot be read.
func (s *Service) stepsOf(ctx context.Context, version string) []api.GraphStep {
	ref, err := uri.Parse(version)
	if err != nil {
		return nil
	}
	id, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil
	}
	v, err := s.Store.GetVersion(ctx, id, ref.Vno)
	if err != nil {
		return nil
	}
	var spec api.WorkflowSpec
	if json.Unmarshal(v.Content, &spec) != nil {
		return nil
	}
	return stepsOfSpec(spec)
}

func stepsOfSpec(spec api.WorkflowSpec) []api.GraphStep {
	port := func(p string) int {
		n, _ := strconv.Atoi(p[strings.LastIndex(p, "-")+1:])
		return n
	}
	links := slices.Clone(spec.Links)
	slices.SortStableFunc(links, func(a, b api.WorkflowLink) int { return port(a.Target.PortID) - port(b.Target.PortID) })
	ops := map[string]bool{}
	var remaining []api.WorkflowOperator
	for _, op := range spec.Operators {
		if op.IsDisabled != nil && *op.IsDisabled {
			continue
		}
		ops[op.OperatorID] = true
		remaining = append(remaining, op)
	}
	inputs := map[string][]string{}
	for _, l := range links {
		if ops[l.Source.OperatorID] && ops[l.Target.OperatorID] {
			inputs[l.Target.OperatorID] = append(inputs[l.Target.OperatorID], l.Source.OperatorID)
		}
	}
	placed := map[string]bool{}
	steps := make([]api.GraphStep, 0, len(remaining))
	for len(remaining) > 0 {
		i := slices.IndexFunc(remaining, func(op api.WorkflowOperator) bool {
			return !slices.ContainsFunc(inputs[op.OperatorID], func(in string) bool { return !placed[in] })
		})
		if i < 0 {
			i = 0
		}
		op := remaining[i]
		remaining = slices.Delete(remaining, i, i+1)
		placed[op.OperatorID] = true
		step := api.GraphStep{Id: op.OperatorID, Type: op.OperatorType}
		if len(op.OperatorProperties) > 0 {
			settings := op.OperatorProperties
			step.Settings = &settings
		}
		if in := inputs[op.OperatorID]; len(in) > 0 {
			step.Inputs = &in
		}
		steps = append(steps, step)
	}
	return steps
}

// planSteps are the operators of the workflow a run ran: those in its plan and those it skipped.
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

// chatSaid is what a chat's messages say beyond their text: what its latest start_work call
// said it would make, and the calls its agent made to MCP servers' tools.
type chatSaid struct {
	// The latest plan and its turn; an earlier plan is done or given up.
	plan     []planItem
	planTurn string
	// Each turn's place in the chat, by its first message.
	turns map[string]int
	// The calls to each server's tools, and the servers in the order they were first called.
	calls   map[string][]api.GraphCall
	servers []string
}

func (s *Service) chatSaid(ctx context.Context, rid uuid.UUID) (*chatSaid, error) {
	out := &chatSaid{calls: map[string][]api.GraphCall{}, turns: map[string]int{}}
	var after int64
	for {
		messages, err := s.Store.ListMessages(ctx, rid, after, 500)
		if err != nil {
			return nil, err
		}
		for _, m := range messages {
			after = m.Seq
			if turn := deref(m.Turn); turn != "" {
				if _, ok := out.turns[turn]; !ok {
					out.turns[turn] = len(out.turns)
				}
			}
			var parts []api.MessagePart
			if json.Unmarshal(m.Parts, &parts) != nil {
				continue
			}
			for _, p := range parts {
				if p.Type != api.MessagePartTypeToolCall || p.ToolName == nil {
					continue
				}
				if *p.ToolName == "start_work" {
					out.plan, out.planTurn = planOf(p.Args), deref(m.Turn)
				}
				if p.Server != nil {
					server := string(*p.Server)
					if _, ok := out.calls[server]; !ok {
						out.servers = append(out.servers, server)
					}
					out.calls[server] = append(out.calls[server], api.GraphCall{Tool: *p.ToolName, Asked: askedOf(p.Args), Turn: deref(m.Turn)})
				}
			}
		}
		if len(messages) < 500 {
			return out, nil
		}
	}
}

// notMade is what the chat's latest plan said it would make that it has not made yet. An item
// is made when the graph holds a thing of its kind and name; failing that, by the first thing of
// its kind the chat made in the plan's turn or after it that no item names; and a run by a run
// the chat started then, of the workflow the item names when one does. Plans name kinds as the
// agent writes them, so a unit or a run is read under its other names too.
func (c *chatSaid) notMade(g *chatGraph, runs []chatRun) []api.PlannedItem {
	out := []api.PlannedItem{}
	since, ok := c.turns[c.planTurn]
	if len(c.plan) == 0 || !ok {
		return out
	}
	after := func(turn *string) bool {
		if turn == nil {
			return false
		}
		i, ok := c.turns[*turn]
		return ok && i >= since
	}
	key := func(kind, name string) string { return kind + "\x00" + strings.ToLower(strings.TrimSpace(name)) }
	held := map[string]bool{}
	for _, n := range g.nodes {
		held[key(string(n.Kind), n.Name)] = true
	}
	named := map[string]bool{}
	for _, item := range c.plan {
		named[key(planKind(item.Kind), item.Name)] = true
	}
	taken := map[*api.GraphNode]bool{}
	var later []chatRun
	for _, r := range runs {
		if after(&r.turn) {
			later = append(later, r)
		}
	}
	slices.Reverse(later) // oldest first
	ranTaken := make([]bool, len(later))
	for _, item := range c.plan {
		kind := planKind(item.Kind)
		if item.Name == "" || held[key(kind, item.Name)] {
			continue
		}
		if kind == "execution" {
			i := slices.IndexFunc(later, func(r chatRun) bool {
				return strings.Contains(strings.ToLower(item.Name), strings.ToLower(r.workflow))
			})
			if i < 0 || ranTaken[i] {
				i = slices.Index(ranTaken, false)
			}
			if i >= 0 {
				ranTaken[i] = true
				continue
			}
		} else if n := g.madeSince(kind, after, func(n *api.GraphNode) bool {
			return !taken[n] && !named[key(string(n.Kind), n.Name)]
		}); n != nil {
			taken[n] = true
			continue
		}
		planned := api.PlannedItem{Name: item.Name, Turn: c.planTurn}
		if item.Kind != "" {
			planned.Kind = &kind
		}
		if item.Detail != "" {
			planned.Detail = &item.Detail
		}
		out = append(out, planned)
	}
	return out
}

// madeSince is the first node of a kind the chat made in a turn that passes, and that is free.
func (g *chatGraph) madeSince(kind string, after func(*string) bool, free func(*api.GraphNode) bool) *api.GraphNode {
	for _, n := range g.nodes {
		if string(n.Kind) == kind && n.Made && after(n.Turn) && free(n) {
			return n
		}
	}
	return nil
}

// planKind reads the kind a plan names as the catalog names it: the agent may write a unit, a
// run or a function.
func planKind(kind string) string {
	switch k := strings.ToLower(strings.TrimSpace(kind)); k {
	case "unit", "units", "computing unit", "computing units", "computing-units":
		return "computing-unit"
	case "run", "runs", "execution", "executions", "workflow run":
		return "execution"
	case "function", "functions", "custom operator", "operators":
		return "operator"
	case "workflows":
		return "workflow"
	case "datasets", "table":
		return "dataset"
	default:
		return k
	}
}

// consulted is the outside servers the chat's agent called, as the caller may see them: not the
// platform's own server, which every chat calls.
func (s *Service) consulted(ctx context.Context, caller *auth.Caller, c *chatSaid) []api.GraphSource {
	out := []api.GraphSource{}
	for _, server := range c.servers {
		r, err := s.resourceByURI(ctx, caller, server, &mcpServerKind)
		if err != nil || s.ownMcpServer(r) {
			continue
		}
		out = append(out, api.GraphSource{Uri: api.Uri(URI(r).String()), Name: r.Name, Calls: c.calls[server]})
	}
	return out
}

// askedOf says in short what a call asked: its text arguments first, then the others, each as
// name: value; a call with one argument says only its value.
func askedOf(args any) string {
	if text, ok := args.(string); ok {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) != nil {
			return cut(text)
		}
		args = decoded
	}
	m, ok := args.(map[string]any)
	if !ok {
		if args == nil {
			return ""
		}
		return cut(string(mustJSON(args)))
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b string) int {
		_, at := m[a].(string)
		_, bt := m[b].(string)
		if at != bt {
			if at {
				return -1
			}
			return 1
		}
		return strings.Compare(a, b)
	})
	said := make([]string, 0, len(keys))
	for _, k := range keys {
		v, ok := m[k].(string)
		if !ok {
			v = string(mustJSON(m[k]))
		}
		if len(keys) == 1 {
			return cut(v)
		}
		said = append(said, k+": "+v)
	}
	return cut(strings.Join(said, ", "))
}

// cut puts text on one line, and no more of it than fits there.
func cut(text string) string {
	const most = 140
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > most {
		return string(r[:most-1]) + "…"
	}
	return text
}

type planItem struct {
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Detail string `json:"detail"`
}

// planOf reads what a start_work call said it would make, from its arguments as stored: an
// object, or its JSON text.
func planOf(args any) []planItem {
	raw, ok := args.(string)
	if !ok {
		raw = string(mustJSON(args))
	}
	var plan struct {
		Makes []planItem `json:"makes"`
	}
	_ = json.Unmarshal([]byte(raw), &plan)
	return plan.Makes
}

// shownPort tells whether a run shows a port's rows rather than keeping them only for reuse; a
// run of an earlier release, whose plan says neither, shows all it kept.
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
