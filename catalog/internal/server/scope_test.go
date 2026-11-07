package server_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// inChat starts a turn of a conversation and returns the headers of a call made in it: the
// chat as the call's origin, vouched for by the runtime.
func inChat(h *harness, token string, conv envelope) []string {
	h.t.Helper()
	var turn api.Turn
	h.mustJSON(token, "POST", p+"/conversations/"+rid(conv)+"/turns", map[string]any{}, &turn)
	return []string{"X-Texera-Origin", "conversation=" + rid(conv) + ";turn=" + turn.Turn + ";template=" + string(turn.Template), "X-Texera-Service-Token", "service"}
}

// turnOf reads the turn out of the headers inChat made.
func turnOf(headers []string) string {
	origin := headers[1]
	start := strings.Index(origin, ";turn=") + len(";turn=")
	return origin[start : start+strings.Index(origin[start:], ";")]
}

// has checks which names a list holds and which it does not.
func has(t *testing.T, what string, names map[string]bool, present []string, absent ...string) {
	t.Helper()
	for _, name := range present {
		if !names[name] {
			t.Errorf("%s: no %q in %v", what, name, names)
		}
	}
	for _, name := range absent {
		if names[name] {
			t.Errorf("%s: %q is listed", what, name)
		}
	}
}

// A scope is a project and what it inherits: its own resources and those of the projects up its
// chain, Texera's among them, not another project's. Without one a list holds everything the
// caller may read.
func TestAScopeIsAProjectAndWhatItInherits(t *testing.T) {
	h := newHarness(t)
	home := string(me(h, "alice").HomeProject)
	lab := h.create("alice", "projects", "lab", map[string]any{})
	h.create("alice", "skills", "in home", aSkill)
	inLab := createIn(h, "alice", "skills", "in lab", lab.Metadata.Rid, aSkill)
	createIn(h, "alice", "computing-units", "lab unit", lab.Metadata.Rid, map[string]any{"provider": "static", "endpoint": h.unit.URL})
	const shipped = "texera-workflows"

	has(t, "no scope", list(h, "alice", "/skills?limit=200"), []string{"in home", "in lab", shipped})
	for _, path := range []string{"/skills?limit=200", "/resources?kind=skill&limit=200"} {
		has(t, "home "+path, list(h, "alice", path+"&scope="+home), []string{"in home", shipped}, "in lab")
		has(t, "lab "+path, list(h, "alice", path+"&scope="+rid(lab)), []string{"in lab", shipped}, "in home")
	}
	// The units one may run on, the same way.
	units := func(scope string) map[string]bool {
		var available []envelope
		h.mustJSON("alice", "GET", p+"/computing-units/available"+scope, nil, &available)
		names := map[string]bool{}
		for _, u := range available {
			names[u.Metadata.Name] = true
		}
		return names
	}
	has(t, "units, no scope", units(""), []string{"lab unit", "test unit"})
	has(t, "units of the lab", units("?scope="+rid(lab)), []string{"lab unit", "test unit"})
	has(t, "units of home", units("?scope="+home), []string{"test unit"}, "lab unit")

	// An exact project inherits nothing.
	has(t, "project=lab", list(h, "alice", "/skills?project="+rid(lab)), []string{"in lab"}, "in home", shipped)
	// Projects are the scopes themselves: a scope hides none of them.
	has(t, "projects", list(h, "alice", "/projects?scope="+rid(lab)), []string{"lab", "Texera", "alice's home"})
	// A scope names a project.
	if status, data := h.do("alice", "GET", p+"/skills?scope="+rid(inLab), nil); status != http.StatusBadRequest {
		t.Errorf("a skill as a scope: %d %s", status, data)
	}
	// Someone else's project as a scope shows what they may read of it: what Texera holds alone.
	has(t, "bob in the lab", list(h, "bob", "/skills?limit=200&scope="+rid(lab)), []string{shipped}, "in lab", "in home")
}

// A call made in a chat is scoped to the chat's project when it names no scope, and what it
// makes goes into that project: an agent works where the chat is.
func TestACallInAChatWorksInTheChatsProject(t *testing.T) {
	h := newHarness(t)
	home := me(h, "alice").HomeProject
	lab := h.create("alice", "projects", "lab", map[string]any{})
	h.create("alice", "skills", "in home", aSkill)
	createIn(h, "alice", "skills", "in lab", lab.Metadata.Rid, aSkill)
	conv := createIn(h, "alice", "conversations", "lab chat", lab.Metadata.Rid, map[string]any{})
	chat := inChat(h, "alice", conv)
	const shipped = "texera-workflows"

	has(t, "in the chat", list(h, "alice", "/skills?limit=200", chat...), []string{"in lab", shipped}, "in home")
	has(t, "a search in the chat", list(h, "alice", "/resources?kind=skill&limit=200", chat...), []string{"in lab", shipped}, "in home")
	// Another project by name; and what names its own place is not narrowed by the chat.
	has(t, "another scope", list(h, "alice", "/skills?limit=200&scope="+string(home), chat...), []string{"in home", shipped}, "in lab")
	has(t, "an exact project", list(h, "alice", "/skills?project="+string(home), chat...), []string{"in home"}, "in lab", shipped)
	has(t, "outside a chat", list(h, "alice", "/skills?limit=200"), []string{"in home", "in lab", shipped})

	empty := map[string]any{"operators": []any{}, "links": []any{}}
	make := func(token, name string, body map[string]any, headers ...string) api.Rid {
		t.Helper()
		body["name"], body["spec"] = name, empty
		var made envelope
		h.mustJSON(token, "POST", p+"/workflows", body, &made, headers...)
		return made.Metadata.Project
	}
	if in := make("alice", "made in the chat", map[string]any{}, chat...); in != lab.Metadata.Rid {
		t.Errorf("what the chat made is in %s", in)
	}
	if in := make("alice", "sent home", map[string]any{"parent": home}, chat...); in != home {
		t.Errorf("a named project: %s", in)
	}
	if in := make("alice", "made outside", map[string]any{}); in != home {
		t.Errorf("outside a chat: %s", in)
	}
	// Bob may talk in the chat but not write to its project: what he makes there is his own.
	bob := me(h, "bob")
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(conv)+"/grants/"+string(bob.Principal.Pid), map[string]any{"relation": "editor"}, nil)
	h.mustJSON("alice", "DELETE", p+"/conversations/"+rid(conv)+"/turns/"+turnOf(chat), nil, nil)
	if in := make("bob", "bob's, made in the chat", map[string]any{}, inChat(h, "bob", conv)...); in != bob.HomeProject {
		t.Errorf("what bob made in alice's chat is in %s", in)
	}
}
