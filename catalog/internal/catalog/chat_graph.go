package catalog

// The lineage graph beside a chat (graph.go draws it): what the chat made and worked from, as
// the catalog records them, and its executions; with what its latest start_work call said it
// would make and has not made yet, and the outside servers its agent consulted.

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// ConversationGraph is the lineage graph of a chat, as the caller may see it: what the chat
// touched, shown while its agent works. A workflow shows the newest version the chat has of it
// beside those executed; a dataset or a model that nothing on the graph reads or uses, the
// newest version the chat has; a unit it made, on the executions on it, or until one is, as
// what its next execution will run on.
func (s *Service) ConversationGraph(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*api.ResourceGraph, error) {
	items, err := s.ConversationResources(ctx, caller, rid)
	if err != nil {
		return nil, err
	}
	g := s.newGraph(ctx, caller, &rid)
	var executions []*store.Resource
	var things []madeThing
	for i := range items {
		item := &items[i]
		r := &item.Resource
		thing := madeThing{uri: URI(r).String(), kind: r.Kind, name: r.Name, made: item.Made}
		if r.Origin != nil && r.Origin.Conversation == rid {
			turn := r.Origin.Turn
			thing.turn = &turn
		}
		things = append(things, thing)
		if r.Kind == "execution" {
			executions = append(executions, r)
			continue
		}
		n := g.add(r)
		if n == nil {
			continue
		}
		n.Made = n.Made || item.Made
		newest := r.HeadVno
		if len(item.Versions) > 0 {
			newest = item.Versions[0].Vno
		}
		for _, v := range item.Versions {
			if v.Made {
				g.madeVersions[string(n.Uri)+"@"+strconv.Itoa(v.Vno)] = true
				g.touch(string(n.Uri), v.CreatedAt)
			}
		}
		if n.Role == api.GraphRoleWorkflow && newest > 0 {
			g.version(n, newest)
		} else {
			g.otherwise(n, newest)
		}
	}
	slices.SortStableFunc(executions, func(a, b *store.Resource) int { return b.CreatedAt.Compare(a.CreatedAt) })
	for _, x := range executions {
		g.execution(x)
	}
	g.workflowsInOrder()
	out, err := g.done()
	if err != nil {
		return nil, err
	}
	// The units the chat made that nothing on the graph ran on yet: what it is about to run on.
	ranOn := map[api.Uri]bool{}
	for _, x := range g.executions {
		if x.Unit != nil {
			ranOn[x.Unit.Uri] = true
		}
	}
	for i := range items {
		if r := &items[i].Resource; r.Kind == "computing-unit" && items[i].Made && !ranOn[api.Uri(URI(r).String())] {
			if u := g.unit(URI(r).String()); u != nil {
				out.Units = append(out.Units, *u)
			}
		}
	}
	// What the plan names may be on the graph without the chat having had it.
	for _, n := range out.Nodes {
		if !slices.ContainsFunc(things, func(t madeThing) bool { return t.uri == string(n.Uri) }) {
			things = append(things, madeThing{uri: string(n.Uri), kind: string(n.Kind), name: n.Name, made: n.Made, turn: n.Turn})
		}
	}
	said, err := s.chatSaid(ctx, rid)
	if err != nil {
		return nil, err
	}
	out.Planned = said.notMade(things, g.ran)
	out.Sources = s.consulted(ctx, caller, said)
	return out, nil
}

// madeThing is something of a chat a plan's item may name: a resource it made or worked from,
// or one on its graph.
type madeThing struct {
	uri, kind, name string
	made            bool
	// The turn of the chat that made it.
	turn *string
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
// is made when the chat has a thing of its kind and name; failing that, by the first thing of
// its kind the chat made in the plan's turn or after it that no item names; and an execution by
// one the chat started then, of the workflow the item names when one does. Plans name kinds as
// the agent writes them, so a unit or an execution is read under its other names too.
func (c *chatSaid) notMade(things []madeThing, runs []chatRun) []api.PlannedItem {
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
	for _, t := range things {
		held[key(t.kind, t.name)] = true
	}
	named := map[string]bool{}
	for _, item := range c.plan {
		named[key(planKind(item.Kind), item.Name)] = true
	}
	taken := make([]bool, len(things))
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
		} else if i := firstMade(things, taken, func(t madeThing) bool {
			return t.kind == kind && after(t.turn) && !named[key(t.kind, t.name)]
		}); i >= 0 {
			taken[i] = true
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

// firstMade is the place of the first thing the chat made that is free and passes; -1 when none.
func firstMade(things []madeThing, taken []bool, passes func(madeThing) bool) int {
	for i, t := range things {
		if t.made && !taken[i] && passes(t) {
			return i
		}
	}
	return -1
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
