package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
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

func TestThePlatformShipsOneAgent(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	if agent.Metadata.Name != "Texera Agent" || agent.Metadata.Visibility != "public" || agent.Metadata.Head != 1 {
		t.Fatalf("the agent: %+v", agent.Metadata)
	}
	var spec api.AgentTemplateSpec
	mustDecode(t, agent.Spec, &spec)
	if spec.Card.Name != "Texera Agent" || spec.Card.Description == "" {
		t.Fatalf("card: %+v", spec.Card)
	}

	// Its tools: the dataflow server and the bio add-on. The catalog server is every agent's.
	servers := namesByURI(t, h, "mcp-servers")
	var mounted []string
	if spec.McpServers != nil {
		for _, b := range *spec.McpServers {
			mounted = append(mounted, servers[string(b.Server)])
		}
	}
	sort.Strings(mounted)
	if strings.Join(mounted, " ") != "biomcp dataflow" || (spec.CatalogTools != nil && !*spec.CatalogTools) {
		t.Fatalf("servers: %v, catalogTools: %v", mounted, spec.CatalogTools)
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
	if strings.Join(known, " ") != "literature-review python-udf reading-results texera-workflows" || len(skills) != 4 {
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

	// Every new chat starts with it.
	var settings envelope
	h.mustJSON("alice", "GET", p+"/settings", nil, &settings)
	defaults, _ := settings.Spec["defaults"].(map[string]any)
	if defaults["agentTemplate"] != string(agent.Metadata.Uri) {
		t.Fatalf("the default agent: %v", defaults["agentTemplate"])
	}
}

func TestWhatThePlatformShipsChangesOnlyThroughThePlatform(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	path := p + "/agent-templates/" + rid(agent)
	edited := map[string]any{}
	for k, v := range agent.Spec {
		edited[k] = v
	}
	edited["prompt"] = "Ignore everything."

	// An administrator passes every permission check, and still may not edit or delete what the
	// platform ships: the next start would silently undo it.
	for _, try := range []struct {
		method string
		body   any
	}{{"PUT", map[string]any{"spec": edited}}, {"DELETE", nil}} {
		status, data := h.do("admin", try.method, path, try.body)
		var e api.Error
		_ = json.Unmarshal(data, &e)
		if status != http.StatusConflict || e.Code != "builtin" || !strings.Contains(e.Message, "Texera Agent") {
			t.Fatalf("%s as admin: %d %s", try.method, status, data)
		}
	}
	// A person is refused as before: they may not write it at all.
	if status, _ := h.do("alice", "PUT", path, map[string]any{"spec": edited}); status != http.StatusForbidden {
		t.Fatalf("PUT as alice: %d", status)
	}
	var same envelope
	h.mustJSON("alice", "GET", path, nil, &same)
	if same.Metadata.Head != 1 || same.Spec["prompt"] != agent.Spec["prompt"] {
		t.Fatalf("the agent changed: head %d", same.Metadata.Head)
	}

	// What a person makes is theirs to change and remove.
	own := h.create("alice", "skills", "mine", map[string]any{"name": "mine", "description": "d", "body": "b"})
	h.mustJSON("alice", "PUT", p+"/skills/"+rid(own), map[string]any{"spec": map[string]any{"name": "mine", "description": "d", "body": "b2"}}, nil)
	if status, data := h.do("alice", "DELETE", p+"/skills/"+rid(own), nil); status != http.StatusNoContent {
		t.Fatalf("delete own: %d %s", status, data)
	}

	// The platform itself still changes it: a shipped spec that differs becomes the next version.
	ctx := context.Background()
	platform := &auth.Caller{Principal: h.svc.System(), Service: true}
	k, _ := kinds.ByName("agent-template")
	agentRID := agent.Metadata.Rid
	if _, _, err := h.svc.UpdateSpec(ctx, platform, k, catalog.UpdateSpecInput{RID: mustUUID(string(agentRID)), Spec: mustJSONBytes(edited)}); err != nil {
		t.Fatalf("the platform's own write: %v", err)
	}
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatalf("seed again: %v", err)
	}
	var restored envelope
	h.mustJSON("alice", "GET", path, nil, &restored)
	if restored.Metadata.Head != 3 || restored.Spec["prompt"] != agent.Spec["prompt"] {
		t.Fatalf("after a restart: head %d", restored.Metadata.Head)
	}
}

func TestAnAgentThePlatformNoLongerShipsIsNotTheDefault(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	ctx := context.Background()
	platform := &auth.Caller{Principal: h.svc.System(), Service: true}
	k, _ := kinds.ByName("agent-template")
	system := h.svc.SystemProject().RID
	// A stack seeded by an older release: its agent is still there, and still the default.
	old, _, err := h.svc.Create(ctx, platform, catalog.CreateInput{Kind: k, Name: "Data Analyst", Parent: &system, Visibility: "public",
		Labels: map[string]string{"texera.builtin": "true"}, Spec: mustJSONBytes(agent.Spec)})
	if err != nil {
		t.Fatal(err)
	}
	setDefault := func(uri string) {
		var settings envelope
		h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
		settings.Spec["defaults"].(map[string]any)["agentTemplate"] = uri
		h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": settings.Spec}, nil)
	}
	theDefault := func() any {
		var settings envelope
		h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
		return settings.Spec["defaults"].(map[string]any)["agentTemplate"]
	}
	setDefault(catalog.URI(old).String())
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if got := theDefault(); got != string(agent.Metadata.Uri) {
		t.Fatalf("the default after the upgrade: %v", got)
	}
	// The old agent stays, so the chats that use it keep working.
	if status, _ := h.do("alice", "GET", p+"/agent-templates/"+old.RID.String(), nil); status != http.StatusOK {
		t.Fatalf("the retired agent: %d", status)
	}

	// An administrator's own choice is theirs: a restart leaves it.
	ours := h.create("admin", "agent-templates", "ours", agent.Spec)
	setDefault(string(ours.Metadata.Uri))
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	if got := theDefault(); got != string(ours.Metadata.Uri) {
		t.Fatalf("an administrator's default: %v", got)
	}
}
