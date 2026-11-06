package server_test

import (
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// settingsOf reads what a turn of a chat runs with, for a person.
func settingsOf(h *harness, token, rid string) api.ChatSettings {
	h.t.Helper()
	var out api.ChatSettings
	h.mustJSON(token, "GET", p+"/conversations/"+rid+"/settings", nil, &out)
	return out
}

// said renders a setting as "name from".
func said(s api.Setting) string { return s.Name + " from " + string(s.From) }

// mounts renders the servers of a turn, in order: "name from", with what marks each.
func mounts(s api.ChatSettings) string {
	var out []string
	for _, m := range s.McpServers {
		text := m.Name + " from " + string(m.From)
		if m.Platform {
			text += ", the platform's"
		}
		if m.Allow != nil {
			text += ", only " + strings.Join(*m.Allow, " ")
		}
		out = append(out, text)
	}
	return strings.Join(out, "; ")
}

func uriOf(e envelope) string { return string(e.Metadata.Uri) }

// choose replaces the choices of a chat.
func choose(h *harness, token string, conv envelope, spec map[string]any) {
	h.t.Helper()
	h.mustJSON(token, "PUT", p+"/conversations/"+rid(conv), map[string]any{"spec": spec}, nil)
}

// A chat stores choices and nothing else, and a new one stores none: it runs with the
// platform's agent and the agent's model and servers.
func TestANewChatStoresNothingAndRunsWithTheDefaults(t *testing.T) {
	h := newHarness(t)
	conv := h.create("alice", "conversations", "a chat", map[string]any{})
	if len(conv.Spec) != 0 {
		t.Fatalf("a new chat stores %v", conv.Spec)
	}
	agent := theAgent(t, h)
	got := settingsOf(h, "alice", rid(conv))
	if got.Project.Rid != me(h, "alice").HomeProject || got.Project.Name != "alice's home" {
		t.Errorf("project: %+v", got.Project)
	}
	if got.Agent.Uri != api.Uri(uriOf(agent)+"@1") || said(got.Agent) != "Texera Agent from platform" {
		t.Errorf("agent: %+v", got.Agent)
	}
	if said(got.ModelEndpoint) != "anthropic-platform from agent" {
		t.Errorf("model: %+v", got.ModelEndpoint)
	}
	if mounts(got) != "catalog from agent, the platform's; biomcp from agent" {
		t.Errorf("servers: %s", mounts(got))
	}
	if got.Skipped != nil {
		t.Errorf("skipped: %+v", *got.Skipped)
	}

	// A chat that is not started yet runs with the same, as its project says.
	var fresh api.ChatSettings
	h.mustJSON("alice", "GET", p+"/projects/"+string(me(h, "alice").HomeProject)+"/chat-settings", nil, &fresh)
	if !reflect.DeepEqual(fresh, got) {
		t.Errorf("a chat not started yet: %+v", fresh)
	}
	// A turn runs that agent at that version.
	var turn api.Turn
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	if turn.Template != got.Agent.Uri {
		t.Errorf("the turn runs %s", turn.Template)
	}
	// Somebody else's chat and project say nothing to bob.
	if status, _ := h.do("bob", "GET", p+"/conversations/"+rid(conv)+"/settings", nil); status != http.StatusForbidden {
		t.Errorf("bob reads the settings of alice's chat: %d", status)
	}
	if status, _ := h.do("bob", "GET", p+"/projects/"+string(me(h, "alice").HomeProject)+"/chat-settings", nil); status != http.StatusForbidden {
		t.Errorf("bob reads the settings of alice's project: %d", status)
	}
}

// The chat's choice comes first, then the project's, then the agent's own or the platform's.
// The add-ons a chat lists take the place of the agent's and the project's; the platform's own
// server is not an add-on and stays.
func TestAChatsChoiceComesFirstThenTheProjectsThenTheAgents(t *testing.T) {
	h := newHarness(t)
	home := string(me(h, "alice").HomeProject)
	conv := h.create("alice", "conversations", "a chat", map[string]any{})
	endpoint := func(name string) envelope {
		return h.create("alice", "model-endpoints", name, map[string]any{"provider": "anthropic", "model": name})
	}
	server := func(name string) envelope {
		return h.create("alice", "mcp-servers", name, map[string]any{"url": "http://" + name + ".test/mcp"})
	}
	projectModel, chatModel := endpoint("project-model"), endpoint("chat-model")
	projectServer, chatServer := server("project-server"), server("chat-server")

	h.mustJSON("alice", "PUT", p+"/projects/"+home, map[string]any{"spec": map[string]any{
		"defaultModelEndpoint": uriOf(projectModel), "mcpServers": []string{uriOf(projectServer)},
	}}, nil)
	got := settingsOf(h, "alice", rid(conv))
	if said(got.Agent) != "Texera Agent from platform" || said(got.ModelEndpoint) != "project-model from project" {
		t.Errorf("with the project's defaults: %s, %s", said(got.Agent), said(got.ModelEndpoint))
	}
	if mounts(got) != "catalog from agent, the platform's; biomcp from agent; project-server from project" {
		t.Errorf("with the project's add-on: %s", mounts(got))
	}

	choose(h, "alice", conv, map[string]any{"modelEndpoint": uriOf(chatModel), "mcpServers": []string{uriOf(chatServer)}})
	got = settingsOf(h, "alice", rid(conv))
	if said(got.ModelEndpoint) != "chat-model from chat" {
		t.Errorf("with the chat's choices: %s", said(got.ModelEndpoint))
	}
	if mounts(got) != "catalog from agent, the platform's; chat-server from chat" {
		t.Errorf("with the chat's add-on: %s", mounts(got))
	}

	// A chat can do without any add-on.
	choose(h, "alice", conv, map[string]any{"mcpServers": []string{}})
	if got = settingsOf(h, "alice", rid(conv)); mounts(got) != "catalog from agent, the platform's" {
		t.Errorf("with every add-on off: %s", mounts(got))
	}

	// An agent of one's own brings its own model and servers; what it may call of a server
	// stays its own rule wherever the server is listed.
	own := h.create("alice", "agent-templates", "mine", map[string]any{
		"card": map[string]any{"name": "mine", "description": "d"}, "model": uriOf(chatModel), "prompt": "p",
		"mcpServers": []any{map[string]any{"server": uriOf(projectServer), "allow": []string{"only_this"}}},
	})
	h.mustJSON("alice", "PUT", p+"/projects/"+home, map[string]any{"spec": map[string]any{"mcpServers": []string{uriOf(projectServer), uriOf(chatServer)}}}, nil)
	choose(h, "alice", conv, map[string]any{"template": uriOf(own)})
	got = settingsOf(h, "alice", rid(conv))
	if got.Agent.Uri != api.Uri(uriOf(own)+"@1") || said(got.Agent) != "mine from chat" || said(got.ModelEndpoint) != "chat-model from agent" {
		t.Errorf("with an agent of one's own: %s (%s), %s", said(got.Agent), got.Agent.Uri, said(got.ModelEndpoint))
	}
	if mounts(got) != "project-server from agent, only only_this; chat-server from project" {
		t.Errorf("its servers: %s", mounts(got))
	}
}

// A chat shared with someone who lacks its owner's rights still works for them: a choice that
// names something they may not use is passed over, and they are told.
func TestAChoiceSomeoneCannotUseIsPassedOverForThem(t *testing.T) {
	h := newHarness(t)
	model := h.create("alice", "model-endpoints", "alice's model", map[string]any{"provider": "anthropic", "model": "m"})
	server := h.create("alice", "mcp-servers", "alice's server", map[string]any{"url": "http://alice.test/mcp"})
	conv := h.create("alice", "conversations", "ours", map[string]any{"modelEndpoint": uriOf(model), "mcpServers": []string{uriOf(server)}})
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(conv)+"/grants/"+string(me(h, "bob").Principal.Pid), map[string]any{"relation": "editor"}, nil)

	hers := settingsOf(h, "alice", rid(conv))
	if said(hers.ModelEndpoint) != "alice's model from chat" || hers.Skipped != nil {
		t.Fatalf("alice's own: %s, skipped %v", said(hers.ModelEndpoint), hers.Skipped)
	}
	if mounts(hers) != "catalog from agent, the platform's; alice's server from chat" {
		t.Fatalf("alice's servers: %s", mounts(hers))
	}

	// The chat's project is where the chat is, also for someone who cannot read that project.
	his := settingsOf(h, "bob", rid(conv))
	if his.Project != hers.Project || his.Project.Name != "alice's home" {
		t.Errorf("bob's view of the chat's project: %+v", his.Project)
	}
	if said(his.ModelEndpoint) != "anthropic-platform from agent" {
		t.Errorf("bob's: %s", said(his.ModelEndpoint))
	}
	if mounts(his) != "catalog from agent, the platform's" {
		t.Errorf("bob's servers: %s", mounts(his))
	}
	passed := map[string]string{}
	if his.Skipped != nil {
		for _, s := range *his.Skipped {
			if s.From != api.SettingSourceChat || s.Reason == "" {
				t.Errorf("passed over: %+v", s)
			}
			passed[string(s.Setting)] = string(s.Uri)
		}
	}
	want := map[string]string{"modelEndpoint": uriOf(model), "mcpServers": uriOf(server)}
	if !reflect.DeepEqual(passed, want) {
		t.Errorf("passed over for bob: %v", passed)
	}
}

// An answer records what wrote it: the agent's version, the model, the servers of its turn.
func TestAnAnswerRecordsWhatWroteIt(t *testing.T) {
	h := newHarness(t)
	conv := h.create("alice", "conversations", "a chat", map[string]any{})
	with := settingsOf(h, "alice", rid(conv))
	servers := []string{string(with.McpServers[0].Uri), string(with.McpServers[1].Uri)}
	var written api.Message
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{
		"role": "assistant", "template": with.Agent.Uri, "modelEndpoint": with.ModelEndpoint.Uri, "mcpServers": servers,
		"parts": []any{map[string]any{"type": "text", "text": "42"}},
	}, &written)
	var page api.MessagePage
	h.mustJSON("alice", "GET", p+"/conversations/"+rid(conv)+"/messages", nil, &page)
	for _, m := range []api.Message{written, page.Items[0]} {
		if m.Template == nil || *m.Template != with.Agent.Uri || m.ModelEndpoint == nil || *m.ModelEndpoint != with.ModelEndpoint.Uri {
			t.Fatalf("agent and model: %v, %v", m.Template, m.ModelEndpoint)
		}
		if m.McpServers == nil || len(*m.McpServers) != 2 || string((*m.McpServers)[1]) != servers[1] {
			t.Fatalf("servers: %v", m.McpServers)
		}
	}
	// What a person says records none of it.
	var asked api.Message
	h.mustJSON("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", map[string]any{"role": "user", "parts": []any{map[string]any{"type": "text", "text": "why?"}}}, &asked)
	if asked.Template != nil || asked.ModelEndpoint != nil || asked.McpServers != nil {
		t.Fatalf("a person's message: %+v", asked)
	}
	// Each names a resource of its kind.
	for field, wrong := range map[string]any{"modelEndpoint": with.Agent.Uri, "mcpServers": []string{string(with.ModelEndpoint.Uri)}, "template": with.ModelEndpoint.Uri} {
		body := map[string]any{"role": "assistant", "parts": []any{}, field: wrong}
		if status, data := h.do("alice", "POST", p+"/conversations/"+rid(conv)+"/messages", body); status != http.StatusBadRequest {
			t.Errorf("%s naming another kind: %d %s", field, status, data)
		}
	}
}
