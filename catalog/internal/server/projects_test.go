package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/store"
)

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

// project makes a project inheriting from a base; an empty base means Texera.
func project(h *harness, token, name string, base api.Rid, spec map[string]any) envelope {
	h.t.Helper()
	body := map[string]any{"name": name, "spec": spec}
	if base != "" {
		body["base"] = base
	}
	var out envelope
	h.mustJSON(token, "POST", p+"/projects", body, &out)
	return out
}

// projectSettings reads what a project's work runs with.
func projectSettings(h *harness, token string, project api.Rid) api.ProjectSettings {
	h.t.Helper()
	var out api.ProjectSettings
	h.mustJSON(token, "GET", p+"/projects/"+string(project)+"/settings", nil, &out)
	return out
}

// refused asserts a request is answered with a status and, when given, an error code.
func refused(t *testing.T, h *harness, token, method, path string, body any, status int, code string) {
	t.Helper()
	got, data := h.do(token, method, p+path, body)
	var e api.Error
	_ = json.Unmarshal(data, &e)
	if got != status || (code != "" && e.Code != code) {
		t.Fatalf("%s %s %s: %d %s, want %d %s", token, method, path, got, data, status, code)
	}
}

var aSkill = map[string]any{"name": "a-skill", "description": "d", "body": "b"}

// Texera is the project every project inherits from: made at install, open to everyone, and
// holding what the release ships. A new project and a person's home inherit from it, and what
// it holds is in every project's lists and nobody else's to see in anyone's own.
func TestTexeraIsTheProjectEveryProjectInheritsFrom(t *testing.T) {
	h := newHarness(t)
	root := me(h, "bob").RootProject
	var texera envelope
	h.mustJSON("bob", "GET", p+"/projects/"+string(root), nil, &texera)
	if texera.Metadata.Name != "Texera" || texera.Metadata.Visibility != "public" || texera.Metadata.Base != nil {
		t.Fatalf("Texera: %+v", texera.Metadata)
	}
	var home envelope
	h.mustJSON("bob", "GET", p+"/projects/"+string(me(h, "bob").HomeProject), nil, &home)
	if home.Metadata.Base == nil || *home.Metadata.Base != root {
		t.Fatalf("bob's home inherits from %v", home.Metadata.Base)
	}
	lab := project(h, "bob", "lab", "", map[string]any{})
	if lab.Metadata.Base == nil || *lab.Metadata.Base != root {
		t.Fatalf("a new project inherits from %v", lab.Metadata.Base)
	}

	// Bob was given nothing: what Texera holds is his to see and use, in every list.
	for _, plural := range []string{"agent-templates", "skills", "mcp-servers", "model-endpoints", "credentials", "profiles", "computing-units", "operators"} {
		var page api.ResourcePage
		h.mustJSON("bob", "GET", p+"/"+plural+"?scope="+rid(lab)+"&limit=200", nil, &page)
		if len(page.Items) == 0 {
			t.Errorf("%s: the lab inherits none from Texera", plural)
		}
		for _, r := range page.Items {
			if r.Metadata.Project != root {
				t.Errorf("%s %q is in project %s", plural, r.Metadata.Name, r.Metadata.Project)
			}
			if status, _ := h.do("bob", "GET", p+"/resources/"+rid(r), nil); status != http.StatusOK {
				t.Errorf("%s %q: bob reads it -> %d", plural, r.Metadata.Name, status)
			}
		}
	}
	// What a person makes is in their own project, and nobody else's to see.
	own := h.create("alice", "skills", "alice's", aSkill)
	if own.Metadata.Project != me(h, "alice").HomeProject {
		t.Fatalf("alice's skill is in project %s", own.Metadata.Project)
	}
	if list(h, "bob", "/skills?limit=200")["alice's"] {
		t.Fatal("bob lists alice's skill")
	}
}

// Texera is a project like any other: its admins change it, rename it, add to it and take from
// it; everyone else uses it and changes nothing. The identity provider's administrator is one of
// its admins, and they may make others admins too. It stays open to everyone and inherits from
// nothing, and it cannot be deleted.
func TestTexerasAdminsChangeItAndNobodyElse(t *testing.T) {
	h := newHarness(t)
	agent := theAgent(t, h)
	root := string(me(h, "alice").RootProject)
	edited := map[string]any{}
	for k, v := range agent.Spec {
		edited[k] = v
	}
	edited["prompt"] = "Answer in haiku."

	// Alice is nobody in Texera.
	refused(t, h, "alice", "PUT", "/agent-templates/"+rid(agent), map[string]any{"spec": edited}, http.StatusForbidden, "forbidden")
	refused(t, h, "alice", "PATCH", "/resources/"+rid(agent), map[string]any{"name": "Ours"}, http.StatusForbidden, "forbidden")
	refused(t, h, "alice", "POST", "/skills", map[string]any{"name": "sneaked in", "parent": root, "spec": aSkill}, http.StatusForbidden, "forbidden")
	refused(t, h, "alice", "PUT", "/projects/"+root, map[string]any{"spec": map[string]any{"branding": map[string]any{"name": "Alice's"}}}, http.StatusForbidden, "forbidden")
	refused(t, h, "alice", "PATCH", "/resources/"+root, map[string]any{"name": "Alice's"}, http.StatusForbidden, "forbidden")
	refused(t, h, "alice", "PUT", "/resources/"+root+"/grants/"+principalOf(h, "alice"), map[string]any{"relation": "owner"}, http.StatusForbidden, "forbidden")

	// The administrator changes the agent, and every chat runs the new version.
	var changed envelope
	h.mustJSON("admin", "PUT", p+"/agent-templates/"+rid(agent), map[string]any{"spec": edited}, &changed)
	if changed.Metadata.Head != agent.Metadata.Head+1 || changed.Spec["prompt"] != "Answer in haiku." {
		t.Fatalf("the agent after the admin's edit: head %d, prompt %v", changed.Metadata.Head, changed.Spec["prompt"])
	}
	h.mustJSON("admin", "POST", p+"/skills", map[string]any{"name": "house style", "parent": root, "spec": aSkill}, nil)
	if !list(h, "alice", "/skills?limit=200")["house style"] {
		t.Fatal("what Texera's admins add is everyone's")
	}
	h.mustJSON("admin", "PATCH", p+"/resources/"+root, map[string]any{"name": "Lab Texera", "description": "The lab's own"}, nil)

	// They make alice an admin too, and she administers Texera from then on.
	h.mustJSON("admin", "PUT", p+"/resources/"+root+"/grants/"+principalOf(h, "alice"), map[string]any{"relation": "owner"}, nil)
	h.mustJSON("alice", "PUT", p+"/projects/"+root, map[string]any{"spec": map[string]any{"branding": map[string]any{"name": "Alice's Texera"}}}, nil)
	if name := projectSettings(h, "bob", me(h, "bob").HomeProject).Branding.Name; name == nil || *name != "Alice's Texera" {
		t.Fatalf("bob's home looks like %v", name)
	}

	// Texera stays what everything rests on.
	refused(t, h, "admin", "PATCH", "/resources/"+root, map[string]any{"visibility": "private"}, http.StatusConflict, "root")
	lab := project(h, "admin", "lab", "", map[string]any{})
	refused(t, h, "admin", "PATCH", "/resources/"+root, map[string]any{"base": rid(lab)}, http.StatusBadRequest, "invalid")
	refused(t, h, "admin", "DELETE", "/projects/"+root, nil, http.StatusConflict, "root")
	refused(t, h, "admin", "PATCH", "/resources/"+root, map[string]any{"labels": map[string]any{}}, http.StatusOK, "")
	if me(h, "bob").RootProject != api.Rid(root) {
		t.Fatal("Texera is lost when its labels are replaced")
	}
}

// A project inherits from its base what its people read and use: the base's resources, and on up
// the chain. Inheriting is sharing, so only an admin of the base makes a project inherit from it;
// nobody changes the base through it, and the base's admins get nothing in the project. The
// base's admins may send it back to Texera, and then its people lose what it inherited.
func TestAProjectInheritsWhatItsBaseHolds(t *testing.T) {
	h := newHarness(t)
	alice, bob := principalOf(h, "alice"), principalOf(h, "bob")
	lab := project(h, "admin", "diabetes lab", "", map[string]any{})
	op := createIn(h, "admin", "operators", "time in range", lab.Metadata.Rid, map[string]any{"implementation": map[string]any{"python": map[string]any{"function": "time_in_range", "code": "import pandas as pd\nfrom pytexera import returns\n\n@returns(share=float)\ndef time_in_range(readings: pd.DataFrame) -> pd.DataFrame:\n    return readings\n"}}})
	profile := createIn(h, "admin", "profiles", "lab node", lab.Metadata.Rid, map[string]any{"memory": "4Gi", "packages": []string{"pandas"}})

	// Alice may not make her study inherit from a lab she does not administer.
	refused(t, h, "alice", "POST", "/projects", map[string]any{"name": "study", "base": rid(lab), "spec": map[string]any{}}, http.StatusForbidden, "forbidden")
	h.mustJSON("admin", "PUT", p+"/resources/"+rid(lab)+"/grants/"+alice, map[string]any{"relation": "owner"}, nil)
	study := project(h, "alice", "study", lab.Metadata.Rid, map[string]any{})
	if study.Metadata.Base == nil || *study.Metadata.Base != lab.Metadata.Rid {
		t.Fatalf("the study inherits from %v", study.Metadata.Base)
	}
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(study)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)

	// Bob, a member of the study, reads and uses what the lab holds, and Texera's things.
	if status, _ := h.do("bob", "GET", p+"/operators/"+rid(op), nil); status != http.StatusOK {
		t.Fatalf("bob reads the lab's operator: %d", status)
	}
	names := list(h, "bob", "/operators?scope="+rid(study)+"&limit=200")
	if !names["time in range"] || !names["CSVFileScan"] {
		t.Fatalf("the study offers %v", names)
	}
	if !list(h, "bob", "/profiles?limit=200")["lab node"] {
		t.Fatal("bob's lists leave out what the study inherits")
	}
	// He changes none of it, and administers nothing up the chain.
	refused(t, h, "bob", "PUT", "/profiles/"+rid(profile), map[string]any{"spec": map[string]any{"memory": "64Gi"}}, http.StatusForbidden, "forbidden")
	refused(t, h, "bob", "POST", "/skills", map[string]any{"name": "mine", "parent": rid(lab), "spec": aSkill}, http.StatusForbidden, "forbidden")
	refused(t, h, "bob", "PUT", "/projects/"+rid(lab), map[string]any{"spec": map[string]any{}}, http.StatusForbidden, "forbidden")
	// A member works in the study and does not change the study itself.
	createIn(h, "bob", "skills", "bob's notes", study.Metadata.Rid, aSkill)
	refused(t, h, "bob", "PUT", "/projects/"+rid(study), map[string]any{"spec": map[string]any{"branding": map[string]any{"name": "Bob's"}}}, http.StatusForbidden, "forbidden")
	refused(t, h, "bob", "PATCH", "/resources/"+rid(study), map[string]any{"name": "Bob's"}, http.StatusForbidden, "forbidden")

	// The lab's admin gets nothing in the study.
	h.mustJSON("admin", "DELETE", p+"/resources/"+rid(lab)+"/grants/"+alice, nil, nil)
	refused(t, h, "admin", "GET", "/projects/"+rid(study), nil, http.StatusForbidden, "forbidden")
	if list(h, "admin", "/skills?limit=200")["bob's notes"] {
		t.Fatal("the lab's admin lists what is in the study")
	}
	// Alice, no longer the lab's admin, cannot point another project at it.
	other := project(h, "alice", "other", "", map[string]any{})
	refused(t, h, "alice", "PATCH", "/resources/"+rid(other), map[string]any{"base": rid(lab)}, http.StatusForbidden, "forbidden")
	// The lab's admin lets the study go, back to Texera; bob loses what it inherited.
	h.mustJSON("admin", "PATCH", p+"/resources/"+rid(study), map[string]any{"base": string(me(h, "admin").RootProject)}, nil)
	if status, _ := h.do("bob", "GET", p+"/operators/"+rid(op), nil); status != http.StatusForbidden {
		t.Fatalf("bob reads the lab's operator after the study left it: %d", status)
	}
	if list(h, "bob", "/operators?scope="+rid(study)+"&limit=200")["time in range"] {
		t.Fatal("the study still offers the lab's operator")
	}
	if !list(h, "bob", "/skills?limit=200")["bob's notes"] {
		t.Fatal("what is in the study stays its own")
	}
}

// A chain goes up to Texera and never loops; a project another inherits from stays while it
// does; and a project is public only when what it inherits is, since its readers read that too.
func TestAChainCannotLoopAndWhatIsInheritedFromStays(t *testing.T) {
	h := newHarness(t)
	lab := project(h, "alice", "lab", "", map[string]any{})
	study := project(h, "alice", "study", lab.Metadata.Rid, map[string]any{})
	thesis := project(h, "alice", "thesis", study.Metadata.Rid, map[string]any{})
	settings := projectSettings(h, "alice", thesis.Metadata.Rid)
	var chain []string
	for _, c := range settings.Chain {
		chain = append(chain, c.Name)
	}
	if strings.Join(chain, " > ") != "thesis > study > lab > Texera" {
		t.Fatalf("the thesis's chain: %v", chain)
	}
	refused(t, h, "alice", "PATCH", "/resources/"+rid(lab), map[string]any{"base": rid(thesis)}, http.StatusBadRequest, "invalid")
	refused(t, h, "alice", "PATCH", "/resources/"+rid(lab), map[string]any{"base": rid(lab)}, http.StatusBadRequest, "invalid")
	status, data := h.do("alice", "DELETE", p+"/projects/"+rid(lab), nil)
	if status != http.StatusConflict || !strings.Contains(string(data), "inherit") || !strings.Contains(string(data), rid(study)) {
		t.Fatalf("deleting a project another inherits from: %d %s", status, data)
	}
	refused(t, h, "alice", "PATCH", "/resources/"+rid(thesis), map[string]any{"visibility": "public"}, http.StatusConflict, "private_base")
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(lab), map[string]any{"visibility": "public"}, nil)
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(study), map[string]any{"visibility": "public"}, nil)
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(thesis), map[string]any{"visibility": "public"}, nil)
	refused(t, h, "alice", "PATCH", "/resources/"+rid(thesis), map[string]any{"parent": rid(lab)}, http.StatusBadRequest, "invalid")
	refused(t, h, "alice", "POST", "/skills", map[string]any{"name": "s", "base": rid(lab), "spec": aSkill}, http.StatusBadRequest, "invalid")
	// Once nothing inherits from it, it goes like any project.
	h.mustJSON("alice", "DELETE", p+"/projects/"+rid(thesis), nil, nil)
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(study), map[string]any{"base": string(me(h, "alice").RootProject)}, nil)
	h.mustJSON("alice", "DELETE", p+"/projects/"+rid(lab), nil, nil)
}

// What a project's work runs with: each preference from the nearest project up its chain that sets
// it, each limit the strictest along it, and where each comes from. A chat and a run of a workflow
// in the project go by the same answer.
func TestSettingsComeFromTheNearestProjectAndLimitsFromTheStrictest(t *testing.T) {
	h := newHarness(t)
	root := me(h, "admin").RootProject
	texera := projectSettings(h, "alice", root)
	if texera.Branding.Name == nil || *texera.Branding.Name != "Texera Test" || texera.Defaults.AgentTemplate == nil || texera.Defaults.Profile == nil || texera.Defaults.Warehouse == nil || texera.Defaults.ComputingUnit == nil || texera.Defaults.ModelEndpoint != nil {
		t.Fatalf("Texera's settings as the release fills them: %+v", texera)
	}
	h.mustJSON("admin", "PUT", p+"/projects/"+string(root), map[string]any{"spec": map[string]any{
		"branding": map[string]any{"name": "Clinic"},
		"defaults": texera.Defaults,
		"limits":   map[string]any{"results": "P90D", "warehouseEndpoints": []string{"http://lake-a:9000", "http://lake-b:9000"}},
	}}, nil)
	lab := project(h, "alice", "lab", "", map[string]any{})
	small := list(h, "alice", "/profiles?limit=200")
	if !small["Small"] {
		t.Fatalf("profiles: %v", small)
	}
	var profiles api.ResourcePage
	h.mustJSON("alice", "GET", p+"/profiles?q=Small&limit=10", nil, &profiles)
	smallURI := profiles.Items[0].Metadata.Uri
	h.mustJSON("alice", "PUT", p+"/projects/"+rid(lab), map[string]any{"spec": map[string]any{
		"defaults": map[string]any{"profile": smallURI, "workMode": "manual"},
		"limits":   map[string]any{"results": "P30D", "warehouseEndpoints": []string{"http://lake-b:9000/", "http://lake-c:9000"}},
	}}, nil)
	study := project(h, "alice", "study", lab.Metadata.Rid, map[string]any{
		"branding": map[string]any{"logoUrl": "https://study.example/logo.svg"},
		"limits":   map[string]any{"results": "P60D"},
	})

	got := projectSettings(h, "alice", study.Metadata.Rid)
	from := func(path string) api.Rid { return got.From[path] }
	switch {
	case got.Branding.Name == nil || *got.Branding.Name != "Clinic" || from("branding.name") != root:
		t.Fatalf("the name: %v from %s", got.Branding.Name, from("branding.name"))
	case got.Branding.LogoUrl == nil || from("branding.logoUrl") != study.Metadata.Rid:
		t.Fatalf("the logo: %v from %s", got.Branding.LogoUrl, from("branding.logoUrl"))
	case got.Defaults.Profile == nil || *got.Defaults.Profile != smallURI || from("defaults.profile") != lab.Metadata.Rid:
		t.Fatalf("the profile: %v from %s", got.Defaults.Profile, from("defaults.profile"))
	case got.Defaults.AgentTemplate == nil || from("defaults.agentTemplate") != root:
		t.Fatalf("the agent: %v from %s", got.Defaults.AgentTemplate, from("defaults.agentTemplate"))
	case got.Limits.Results == nil || from("limits.results") != lab.Metadata.Rid:
		t.Fatalf("the results limit: %v from %s: the lab's 30 days hold over the study's 60 and Texera's 90", got.Limits.Results, from("limits.results"))
	case got.Limits.WarehouseEndpoints == nil || len(*got.Limits.WarehouseEndpoints) != 1 || (*got.Limits.WarehouseEndpoints)[0] != "http://lake-b:9000/":
		t.Fatalf("the stores: %v: only lake-b is on both lists", got.Limits.WarehouseEndpoints)
	}
	if names := []string{got.Chain[0].Name, got.Chain[1].Name, got.Chain[2].Name}; strings.Join(names, ",") != "study,lab,Texera" {
		t.Fatalf("the chain: %v", names)
	}

	// A chat in the study runs Texera's agent, in the lab's work mode, and says so.
	var chat api.ChatSettings
	h.mustJSON("alice", "GET", p+"/projects/"+rid(study)+"/chat-settings", nil, &chat)
	if chat.Agent.From != api.SettingSourceProject || chat.Agent.Project == nil || chat.Agent.Project.Rid != root {
		t.Fatalf("the chat's agent comes from %s %+v", chat.Agent.From, chat.Agent.Project)
	}
	if chat.WorkMode.Mode != api.WorkModeManual || chat.WorkMode.Project == nil || chat.WorkMode.Project.Name != "lab" {
		t.Fatalf("the chat's work mode: %+v", chat.WorkMode)
	}

	// A warehouse in the study may be kept only on a store on every list up the chain.
	key := createIn(h, "alice", "credentials", "store key", study.Metadata.Rid, map[string]any{"kind": "api_key"})
	storage := func(endpoint string) map[string]any {
		return map[string]any{"storage": map[string]any{"endpoint": endpoint, "region": "us-east-1", "bucket": "b", "credential": key.Metadata.Uri}}
	}
	refused(t, h, "alice", "POST", "/warehouses", map[string]any{"name": "on c", "parent": rid(study), "spec": storage("http://lake-c:9000")}, http.StatusBadRequest, "invalid")
	refused(t, h, "alice", "POST", "/warehouses", map[string]any{"name": "on a", "parent": rid(study), "spec": storage("http://lake-a:9000")}, http.StatusBadRequest, "invalid")
}

// A release brings into Texera what it ships, and leaves what Texera's admins did as they left it:
// a changed resource keeps their change, a deleted one stays gone, and an engine operator they
// took away is offered by no project, so no workflow runs it.
func TestAReleaseUpdatesOnlyWhatTexerasAdminsLeftAlone(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	var skills api.ResourcePage
	h.mustJSON("alice", "GET", p+"/skills?limit=200", nil, &skills)
	var skill envelope
	for _, s := range skills.Items {
		if s.Metadata.Name == "using-models" {
			skill = s
		}
	}
	changedSpec := map[string]any{}
	for k, v := range skill.Spec {
		changedSpec[k] = v
	}
	changedSpec["body"] = "Our own way of using models."
	h.mustJSON("admin", "PUT", p+"/skills/"+rid(skill), map[string]any{"spec": changedSpec}, nil)
	var large api.ResourcePage
	h.mustJSON("alice", "GET", p+"/profiles?q=Large&limit=10", nil, &large)
	h.mustJSON("admin", "DELETE", p+"/profiles/"+rid(large.Items[0]), nil, nil)
	var limit api.ResourcePage
	h.mustJSON("alice", "GET", p+"/operators?q=Limit&limit=10", nil, &limit)
	h.mustJSON("admin", "DELETE", p+"/operators/"+rid(limit.Items[0]), nil, nil)

	// The next release ships another model and the same skills, profiles and operators.
	h.svc.Config.ModelName = "claude-sonnet-5-5"
	if err := h.svc.Seed(ctx); err != nil {
		t.Fatal(err)
	}
	units, err := h.svc.Store.ListResources(ctx, store.ResourceFilter{Kind: "computing-unit", ParentRID: &h.svc.Root().RID, Limit: 1})
	if err != nil || len(units) == 0 {
		t.Fatal(err)
	}
	if err := h.svc.SyncOperators(ctx, &units[0]); err != nil {
		t.Fatal(err)
	}
	var endpoints api.ResourcePage
	h.mustJSON("alice", "GET", p+"/model-endpoints?limit=10", nil, &endpoints)
	if len(endpoints.Items) != 1 || endpoints.Items[0].Spec["model"] != "claude-sonnet-5-5" {
		t.Fatalf("the model endpoint nobody changed: %v", endpoints.Items)
	}
	var kept envelope
	h.mustJSON("alice", "GET", p+"/skills/"+rid(skill), nil, &kept)
	if kept.Spec["body"] != "Our own way of using models." {
		t.Fatalf("the skill the admins changed: %v", kept.Spec["body"])
	}
	if list(h, "alice", "/profiles?limit=200")["Large"] {
		t.Fatal("the release brought back a profile the admins deleted")
	}
	if list(h, "alice", "/operators?limit=500")["Limit"] {
		t.Fatal("the sync brought back an operator the admins deleted")
	}
	// No workflow runs an operator its project does not offer.
	wf := h.create("alice", "workflows", "first rows", map[string]any{
		"operators": []any{map[string]any{"operatorID": "first", "operatorType": "Limit", "operatorProperties": map[string]any{"limit": 5}}},
		"links":     []any{},
	})
	status, data := h.do("alice", "POST", p+"/workflows/"+rid(wf)+"/validate", map[string]any{})
	if status != http.StatusBadRequest || !strings.Contains(string(data), "Limit is not an operator") {
		t.Fatalf("validating a workflow with an operator Texera no longer offers: %d %s", status, data)
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
