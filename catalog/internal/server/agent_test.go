package server_test

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

// theAgent is the one agent template the platform ships.
func theAgent(t *testing.T, h *harness) envelope {
	t.Helper()
	var page api.ResourcePage
	h.mustJSON("alice", "GET", p+"/agent-templates", nil, &page)
	if len(page.Items) != 1 {
		var names []string
		for _, tpl := range page.Items {
			names = append(names, tpl.Metadata.Name)
		}
		t.Fatalf("the platform ships one agent, got %v", names)
	}
	return page.Items[0]
}

// namesByURI lists a kind's resources as URI to name.
func namesByURI(t *testing.T, h *harness, plural string) map[string]string {
	t.Helper()
	var page api.ResourcePage
	h.mustJSON("alice", "GET", p+"/"+plural+"?limit=200", nil, &page)
	out := map[string]string{}
	for _, r := range page.Items {
		out[string(r.Metadata.Uri)] = r.Metadata.Name
	}
	return out
}

func TestTexeraHoldsOneAgent(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	if agent.Metadata.Name != "Texera Agent" || agent.Metadata.Project != me(h, "alice").RootProject || agent.Metadata.Head != 1 {
		t.Fatalf("the agent: %+v", agent.Metadata)
	}
	var spec api.AgentTemplateSpec
	mustDecode(t, agent.Spec, &spec)
	if spec.Card.Name != "Texera Agent" || spec.Card.Description == "" {
		t.Fatalf("card: %+v", spec.Card)
	}

	// Its tools: the catalog's own server, which holds every tool of the platform, and the bio
	// add-on. Both are listed; nothing is mounted behind the agent's back.
	servers := namesByURI(t, h, "mcp-servers")
	var mounted []string
	if spec.McpServers != nil {
		for _, b := range *spec.McpServers {
			mounted = append(mounted, servers[string(b.Server)])
		}
	}
	sort.Strings(mounted)
	if strings.Join(mounted, " ") != "biomcp catalog" || len(servers) != 2 {
		t.Fatalf("servers: %v of %d shipped", mounted, len(servers))
	}

	// Its know-how: every skill the platform ships, loaded on demand.
	skills := namesByURI(t, h, "skills")
	var known []string
	if spec.Skills != nil {
		for _, uri := range *spec.Skills {
			known = append(known, skills[string(uri)])
		}
	}
	sort.Strings(known)
	if strings.Join(known, " ") != "computing-units exploring-resources importing-data literature-review python-udf reading-results texera-workflows using-models" || len(skills) != 8 {
		t.Fatalf("skills: %v of %d shipped", known, len(skills))
	}

	// One agent answers every kind of question, so a reply is the answer; nobody to hand off to.
	if spec.Handoffs != nil && len(*spec.Handoffs) > 0 {
		t.Fatalf("handoffs: %v", *spec.Handoffs)
	}
	if spec.Loop == nil || spec.Loop.Answer == nil || *spec.Loop.Answer != api.LoopSpecAnswerFree {
		t.Fatalf("loop: %+v", spec.Loop)
	}
	// The prompt is the shipped file: it names the skills to load and nothing about other agents.
	for _, want := range []string{"load_skill", "texera-workflows", "literature-review"} {
		if !strings.Contains(spec.Prompt, want) {
			t.Errorf("the prompt does not mention %s", want)
		}
	}
	for _, gone := range []string{"<!--", "handoff", "Data Analyst", "Bio Researcher"} {
		if strings.Contains(spec.Prompt, gone) {
			t.Errorf("the prompt still mentions %q", gone)
		}
	}

	// Every new chat starts with it: it is Texera's default, which every project inherits.
	settings := projectSettings(h, "alice", me(h, "alice").HomeProject)
	if settings.Defaults.AgentTemplate == nil || *settings.Defaults.AgentTemplate != agent.Metadata.Uri || settings.From["defaults.agentTemplate"] != me(h, "alice").RootProject {
		t.Fatalf("the default agent: %v from %s", settings.Defaults.AgentTemplate, settings.From["defaults.agentTemplate"])
	}
}

// What a release wrote of a resource it ships, the next one corrects: a description an earlier
// release wrote gives way at the next start, without a new version, since the content did not
// change. What Texera's admins wrote stays.
func TestAReleaseCorrectsWhatAnEarlierOneWroteAndKeepsWhatAdminsWrote(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	var page api.ResourcePage
	h.mustJSON("alice", "GET", p+"/skills?limit=200", nil, &page)
	if len(page.Items) < 2 {
		t.Fatal("the release ships fewer than two skills")
	}
	byRelease, byAdmins := page.Items[0], page.Items[1]
	old := "What an older release said."
	r, err := h.svc.Store.UpdateMetadata(ctx, store.MetadataUpdate{RID: mustUUID(rid(byRelease)), Description: &old})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Store.RecordShipped(ctx, store.Shipped{Kind: "skill", Name: r.Name, RID: r.RID, Digest: catalog.ShippedDigest(r.Spec, r.Description)}); err != nil {
		t.Fatal(err)
	}
	theirs := "What Texera's admins say."
	h.mustJSON("admin", "PATCH", p+"/resources/"+rid(byAdmins), map[string]any{"description": theirs}, nil)

	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	var after envelope
	h.mustJSON("alice", "GET", p+"/skills/"+rid(byRelease), nil, &after)
	if got := after.Metadata.Description; got == nil || *got != *byRelease.Metadata.Description {
		t.Fatalf("the description after a restart: %s", mustJSONBytes(got))
	}
	if after.Metadata.Head != byRelease.Metadata.Head {
		t.Fatalf("a description alone made version %d", after.Metadata.Head)
	}
	h.mustJSON("alice", "GET", p+"/skills/"+rid(byAdmins), nil, &after)
	if got := after.Metadata.Description; got == nil || *got != theirs {
		t.Fatalf("the admins' description after a restart: %s", mustJSONBytes(got))
	}
}

// Texera holds what this release ships and what its admins put there. What an older release
// shipped and this one does not is removed at the next start when nobody changed it, and what
// named it falls back: Texera's default to the shipped agent, a chat to the default. What an
// older release shipped and Texera's admins changed is theirs, and stays.
func TestWhatNoReleaseShipsAnyMoreGoes(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	ctx := context.Background()
	platform := &auth.Caller{Principal: h.svc.System(), Service: true}
	templates, _ := kinds.ByName("agent-template")
	servers, _ := kinds.ByName("mcp-server")
	root := h.svc.Root().RID
	// A stack an older release shipped into: an agent and two servers, the agent the default.
	shippedBefore := func(k kinds.Kind, name string, spec any) *store.Resource {
		r, _, err := h.svc.Create(ctx, platform, catalog.CreateInput{Kind: k, Name: name, Parent: &root, Spec: mustJSONBytes(spec)})
		if err != nil {
			t.Fatal(err)
		}
		if err := h.svc.Store.RecordShipped(ctx, store.Shipped{Kind: k.Name, Name: name, RID: r.RID, Digest: catalog.ShippedDigest(r.Spec, r.Description)}); err != nil {
			t.Fatal(err)
		}
		return r
	}
	old := shippedBefore(templates, "Data Analyst", agent.Spec)
	dataflow := shippedBefore(servers, "dataflow", map[string]any{"url": "http://test/mcp/dataflow"})
	kept := shippedBefore(servers, "kept", map[string]any{"url": "http://test/mcp/kept"})
	h.mustJSON("admin", "PUT", p+"/mcp-servers/"+kept.RID.String(), map[string]any{"spec": map[string]any{"url": "http://test/mcp/ours"}}, nil)
	oldURI := catalog.URI(old).String()
	setDefault := func(uri string) {
		settings := projectSettings(h, "admin", api.Rid(root.String()))
		defaults := settings.Defaults
		u := api.Uri(uri)
		defaults.AgentTemplate = &u
		h.mustJSON("admin", "PUT", p+"/projects/"+root.String(), map[string]any{"spec": map[string]any{"branding": settings.Branding, "defaults": defaults}}, nil)
	}
	theDefault := func() string {
		return string(*projectSettings(h, "admin", api.Rid(root.String())).Defaults.AgentTemplate)
	}
	setDefault(oldURI)
	// A chat that chose the old agent.
	conv := h.create("alice", "conversations", "an old chat", map[string]any{"template": oldURI})
	if got := settingsOf(h, "alice", rid(conv)); said(got.Agent) != "Data Analyst from chat" {
		t.Fatalf("before the upgrade the chat runs %s", said(got.Agent))
	}

	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.relay.Once(ctx); err != nil {
		t.Fatal(err)
	}
	for name, gone := range map[string]string{"the old agent": "/agent-templates/" + old.RID.String(), "the old server": "/mcp-servers/" + dataflow.RID.String()} {
		if status, _ := h.do("alice", "GET", p+gone, nil); status != http.StatusNotFound {
			t.Errorf("%s after the upgrade: %d", name, status)
		}
	}
	if names := list(h, "alice", "/mcp-servers?limit=200"); names["dataflow"] || !names["kept"] || !names["catalog"] || !names["biomcp"] {
		t.Errorf("servers after the upgrade: %v", names)
	}
	if got := theDefault(); got != string(agent.Metadata.Uri) {
		t.Fatalf("the default after the upgrade: %v", got)
	}
	// The chat still names the old agent, which is gone: it runs Texera's, and says why.
	got := settingsOf(h, "alice", rid(conv))
	if said(got.Agent) != "Texera Agent from Texera" || got.Skipped == nil || len(*got.Skipped) != 1 || string((*got.Skipped)[0].Uri) != oldURI {
		t.Fatalf("the old chat after the upgrade: %s, skipped %+v", said(got.Agent), got.Skipped)
	}
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	if turn.Template != got.Agent.Uri {
		t.Fatalf("a turn of the old chat runs %s", turn.Template)
	}

	// What this release ships is untouched by a second start, and so is what Texera's admins
	// chose: an agent of their own as the default.
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if again := theAgent(t, h); again.Metadata.Rid != agent.Metadata.Rid || again.Metadata.Head != agent.Metadata.Head {
		t.Fatalf("the shipped agent after two starts: %+v", again.Metadata)
	}
	ours := createIn(h, "admin", "agent-templates", "ours", api.Rid(root.String()), agent.Spec)
	setDefault(string(ours.Metadata.Uri))
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if got := theDefault(); got != string(ours.Metadata.Uri) {
		t.Fatalf("the admins' default: %v", got)
	}
}
