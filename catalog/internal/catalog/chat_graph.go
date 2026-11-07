package catalog

// The resource graph beside a chat: what it read, made and ran, and how they connect. It is
// computed from what the catalog records already: what the chat made and worked from, its
// executions (what each read, the unit it ran on, the tables it kept), the custom operators its
// workflows name, and what its start_work calls said it would make.

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

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
	g := &chatGraph{byURI: map[string]*api.GraphNode{}, seen: map[api.GraphEdge]bool{}}
	var executions []*store.Resource
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
		n := api.GraphNode{Uri: api.Uri(URI(r).String()), Role: role, Kind: api.ResourceKind(r.Kind), Name: r.Name, Made: item.Made}
		if len(item.Versions) > 0 {
			v := api.Vno(item.Versions[0].Vno)
			n.Version = &v
		}
		g.node(n)
	}

	// Each run: what it read, where it ran, and for the newest of each workflow what it kept.
	slices.SortStableFunc(executions, func(a, b *store.Resource) int { return b.CreatedAt.Compare(a.CreatedAt) })
	newest := map[string]bool{}
	workflowVersions := map[string]string{}
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
		if _, ok := workflowVersions[workflow]; !ok {
			workflowVersions[workflow] = string(spec.Workflow)
		}
		run := api.GraphRun{Uri: api.Uri(URI(exec).String()), Phase: string(status.Phase), Steps: int32(planSteps(spec)), Reused: 0}
		if spec.Reused != nil {
			run.Reused = int32(len(*spec.Reused))
		}
		run.StartedAt, run.FinishedAt = status.StartedAt, status.FinishedAt
		runs := []api.GraphRun{}
		if wfNode.Runs != nil {
			runs = *wfNode.Runs
		}
		runs = append(runs, run)
		wfNode.Runs = &runs
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
		if unit := string(spec.ComputingUnit); unit != "" {
			if g.byURI[unit] == nil {
				if r, err := s.resourceByURI(ctx, caller, unit, &unitKind); err == nil {
					n := api.GraphNode{Uri: api.Uri(unit), Role: api.GraphRoleUnit, Kind: api.ResourceKind(r.Kind), Name: r.Name}
					var us api.ComputingUnitStatus
					if json.Unmarshal(r.Status, &us) == nil && us.Phase != "" {
						phase := string(us.Phase)
						n.State = &phase
					}
					g.node(n)
				}
			}
			g.edge(workflow, unit, api.GraphEdgeRelationRunsOn)
		}
		if newest[workflow] || status.Ports == nil || status.ResultsExpiredAt != nil {
			continue
		}
		newest[workflow] = true
		for _, p := range *status.Ports {
			if p.Table == nil || strings.HasPrefix(*p.Table, "vfs:") {
				continue
			}
			port := URI(exec).String() + "/operators/" + p.OperatorID + "/ports/" + p.PortID
			n := g.node(api.GraphNode{Uri: api.Uri(port), Role: api.GraphRoleData, Kind: api.ResourceKind("execution"), Name: p.OperatorID, Made: true})
			n.Rows = p.Rows
			g.edge(workflow, port, api.GraphEdgeRelationMakes)
		}
	}

	// The functions a workflow's version names.
	var sources []string
	for _, version := range workflowVersions {
		sources = append(sources, version)
	}
	refs, err := s.Store.ReferencesFrom(ctx, sources)
	if err != nil {
		return nil, err
	}
	for _, e := range refs {
		ref, err := uri.Parse(e.To)
		if err != nil || ref.Kind.Name != "operator" {
			continue
		}
		from, err := uri.Parse(e.From)
		if err != nil {
			continue
		}
		g.edge(uri.Of(ref.Kind, ref.Rid).String(), uri.Of(from.Kind, from.Rid).String(), api.GraphEdgeRelationUses)
	}

	planned, err := s.plannedNotMade(ctx, rid, g)
	if err != nil {
		return nil, err
	}
	out := &api.ConversationGraph{Nodes: make([]api.GraphNode, 0, len(g.nodes)), Edges: g.edges, Planned: planned}
	if out.Edges == nil {
		out.Edges = []api.GraphEdge{}
	}
	for _, n := range g.nodes {
		out.Nodes = append(out.Nodes, *n)
	}
	return out, nil
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

// plannedNotMade is what the chat's start_work calls said they would make that the graph does
// not hold yet, by kind and name.
func (s *Service) plannedNotMade(ctx context.Context, rid uuid.UUID, g *chatGraph) ([]api.PlannedItem, error) {
	made := map[string]bool{}
	for _, n := range g.nodes {
		if n.Made {
			made[string(n.Kind)+"\x00"+strings.ToLower(n.Name)] = true
		}
	}
	out := []api.PlannedItem{}
	var after int64
	for {
		messages, err := s.Store.ListMessages(ctx, rid, after, 500)
		if err != nil {
			return nil, err
		}
		for _, m := range messages {
			after = m.Seq
			var parts []api.MessagePart
			if json.Unmarshal(m.Parts, &parts) != nil {
				continue
			}
			for _, p := range parts {
				if p.Type != api.MessagePartTypeToolCall || p.ToolName == nil || *p.ToolName != "start_work" {
					continue
				}
				for _, item := range planOf(p.Args) {
					if item.Name == "" || made[item.Kind+"\x00"+strings.ToLower(item.Name)] {
						continue
					}
					planned := api.PlannedItem{Name: item.Name, Turn: deref(m.Turn)}
					if item.Kind != "" {
						planned.Kind = &item.Kind
					}
					if item.Detail != "" {
						planned.Detail = &item.Detail
					}
					out = append(out, planned)
				}
			}
		}
		if len(messages) < 500 {
			return out, nil
		}
	}
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
