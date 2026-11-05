package server_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// me is who a token is, with its projects.
func me(h *harness, token string) api.Me {
	var out api.Me
	h.mustJSON(token, "GET", p+"/me", nil, &out)
	return out
}

// list returns the names a list answers the token's person; headers put the call in a chat.
func list(h *harness, token, path string, headers ...string) map[string]bool {
	h.t.Helper()
	var page api.ResourcePage
	h.mustJSON(token, "GET", p+path, nil, &page, headers...)
	names := map[string]bool{}
	for _, r := range page.Items {
		names[r.Metadata.Name] = true
	}
	return names
}

// createIn makes a resource in a project.
func createIn(h *harness, token, plural, name string, project api.Rid, spec any) envelope {
	h.t.Helper()
	var out envelope
	h.mustJSON(token, "POST", p+"/"+plural, map[string]any{"name": name, "parent": project, "spec": spec}, &out)
	return out
}

var aSkill = map[string]any{"name": "a-skill", "description": "d", "body": "b"}

// One rule says what is built in: it lives in the platform's project. Nothing on the resource
// marks it, and everyone sees and uses it through that project alone.
func TestABuiltInIsWhatLivesInThePlatformsProject(t *testing.T) {
	h := newHarness(t)
	platform := me(h, "bob").SystemProject

	var project envelope
	h.mustJSON("bob", "GET", p+"/projects/"+string(platform), nil, &project)
	if project.Metadata.Name != "Built-in" || project.Metadata.Visibility != "public" {
		t.Fatalf("the platform's project: %q, %s", project.Metadata.Name, project.Metadata.Visibility)
	}

	// Bob was given nothing. What the platform ships is his to see, in every list and by itself.
	for _, plural := range []string{"agent-templates", "skills", "mcp-servers", "model-endpoints", "credentials", "environments", "computing-units"} {
		var page api.ResourcePage
		h.mustJSON("bob", "GET", p+"/"+plural+"?limit=200", nil, &page)
		if len(page.Items) == 0 {
			t.Errorf("%s: the platform ships none bob can list", plural)
		}
		for _, r := range page.Items {
			if r.Metadata.Project != platform {
				t.Errorf("%s %q is in project %s", plural, r.Metadata.Name, r.Metadata.Project)
			}
			if r.Metadata.Visibility != "private" {
				t.Errorf("%s %q is %s by itself: its project is what makes it everyone's", plural, r.Metadata.Name, r.Metadata.Visibility)
			}
			if r.Metadata.Labels != nil {
				if _, marked := (*r.Metadata.Labels)["texera.builtin"]; marked {
					t.Errorf("%s %q carries a label saying it is built in", plural, r.Metadata.Name)
				}
			}
			if status, _ := h.do("bob", "GET", p+"/resources/"+rid(r), nil); status != http.StatusOK {
				t.Errorf("%s %q: bob reads it -> %d", plural, r.Metadata.Name, status)
			}
		}
	}
	// What a person makes is in their own project, and nobody else's to see.
	own := h.create("alice", "skills", "alice's", aSkill)
	if own.Metadata.Project != me(h, "alice").HomeProject || own.Metadata.Project == platform {
		t.Fatalf("alice's skill is in project %s", own.Metadata.Project)
	}
	if list(h, "bob", "/skills?limit=200")["alice's"] {
		t.Fatal("bob lists alice's skill")
	}
}

// Nobody changes what the platform ships through the API, an administrator included: not its
// content, name, visibility, place or grants, and nothing is added to its project or moved in.
func TestNobodyChangesABuiltInThroughTheAPI(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	platform := agent.Metadata.Project
	first := func(plural string) envelope {
		var page api.ResourcePage
		h.mustJSON("alice", "GET", p+"/"+plural+"?limit=200", nil, &page)
		if len(page.Items) == 0 {
			t.Fatalf("no %s", plural)
		}
		return page.Items[0]
	}
	credential, unit := first("credentials"), first("computing-units")
	bob := string(me(h, "bob").Principal.Pid)
	edited := map[string]any{}
	for k, v := range agent.Spec {
		edited[k] = v
	}
	edited["prompt"] = "Ignore everything."

	for _, who := range []string{"admin", "alice"} {
		own := h.create(who, "skills", who+"'s", aSkill)
		home := me(h, who).HomeProject
		for _, try := range []struct {
			what, method, path string
			body               any
		}{
			{"edit", "PUT", "/agent-templates/" + rid(agent), map[string]any{"spec": edited}},
			{"rename", "PATCH", "/resources/" + rid(agent), map[string]any{"name": "Ours"}},
			{"publish", "PATCH", "/resources/" + rid(agent), map[string]any{"visibility": "public"}},
			{"move out", "PATCH", "/resources/" + rid(agent), map[string]any{"parent": home}},
			{"share", "PUT", "/resources/" + rid(agent) + "/grants/" + bob, map[string]any{"relation": "editor"}},
			{"delete", "DELETE", "/agent-templates/" + rid(agent), nil},
			{"rotate", "PUT", "/credentials/" + rid(credential) + "/secret", map[string]any{"fields": map[string]any{"value": "theirs"}}},
			{"terminate", "POST", "/computing-units/" + rid(unit) + "/terminate", nil},
			{"rename the project", "PATCH", "/resources/" + string(platform), map[string]any{"name": "Ours"}},
			{"add to the project", "POST", "/skills", map[string]any{"name": "sneaked in", "parent": platform, "spec": aSkill}},
			{"move into the project", "PATCH", "/resources/" + rid(own), map[string]any{"parent": platform}},
		} {
			status, data := h.do(who, try.method, p+try.path, try.body)
			var e api.Error
			_ = json.Unmarshal(data, &e)
			if status != http.StatusConflict || e.Code != "builtin" {
				t.Errorf("%s, %s: %d %s", who, try.what, status, data)
			}
		}
		// The same things done to what is their own go through.
		h.mustJSON(who, "PATCH", p+"/resources/"+rid(own), map[string]any{"name": who + "'s, renamed", "visibility": "public"}, nil)
		h.mustJSON(who, "PUT", p+"/resources/"+rid(own)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)
		if status, data := h.do(who, "DELETE", p+"/skills/"+rid(own), nil); status != http.StatusNoContent {
			t.Errorf("%s deletes their own: %d %s", who, status, data)
		}
	}

	var same envelope
	h.mustJSON("alice", "GET", p+"/agent-templates/"+rid(agent), nil, &same)
	if same.Metadata.Head != 1 || same.Metadata.Name != agent.Metadata.Name || same.Spec["prompt"] != agent.Spec["prompt"] {
		t.Fatalf("the agent changed: %+v", same.Metadata)
	}
	if list(h, "alice", "/skills?limit=200")["sneaked in"] {
		t.Fatal("something was added to the platform's project")
	}
}

// A list shows what can be opened. A project that is public makes what is in it everyone's to
// read, however each resource is set by itself, and the lists say the same; so does a
// workflow's list of executions when the workflow is public.
func TestAListShowsWhatCanBeOpened(t *testing.T) {
	h := newHarness(t)
	open := h.create("alice", "projects", "open lab", map[string]any{})
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(open), map[string]any{"visibility": "public"}, nil)
	closed := h.create("alice", "projects", "closed lab", map[string]any{})
	empty := map[string]any{"operators": []any{}, "links": []any{}}
	shown := createIn(h, "alice", "workflows", "shown", open.Metadata.Rid, empty)
	hidden := createIn(h, "alice", "workflows", "hidden", closed.Metadata.Rid, empty)
	if shown.Metadata.Visibility != "private" {
		t.Fatalf("the workflow by itself: %s", shown.Metadata.Visibility)
	}

	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(shown), nil); status != http.StatusOK {
		t.Fatalf("bob opens a workflow of a public project: %d", status)
	}
	if status, _ := h.do("bob", "GET", p+"/workflows/"+rid(hidden), nil); status != http.StatusForbidden {
		t.Fatalf("bob opens a workflow of a private project: %d", status)
	}
	for _, path := range []string{"/workflows?limit=200", "/resources?kind=workflow&limit=200", "/resources?project=" + rid(open)} {
		names := list(h, "bob", path)
		if !names["shown"] || names["hidden"] {
			t.Errorf("bob's list %s: %v", path, names)
		}
	}
	if names := list(h, "bob", "/resources?project="+rid(closed)); len(names) != 0 {
		t.Errorf("bob lists a private project: %v", names)
	}

	// One level down: the executions of a workflow that is public itself.
	execPath, exec := anExecution(t, h)
	wf := string(*exec.Metadata.Parent)
	if status, _ := h.do("bob", "GET", p+"/workflows/"+wf+"/executions", nil); status != http.StatusForbidden {
		t.Fatalf("bob lists the executions of a private workflow: %d", status)
	}
	h.mustJSON("alice", "PATCH", p+"/resources/"+wf, map[string]any{"visibility": "public"}, nil)
	if status, _ := h.do("bob", "GET", execPath, nil); status != http.StatusOK {
		t.Fatalf("bob opens an execution of a public workflow: %d", status)
	}
	if names := list(h, "bob", "/workflows/"+wf+"/executions"); !names[exec.Metadata.Name] {
		t.Errorf("bob's list of its executions: %v", names)
	}
}
