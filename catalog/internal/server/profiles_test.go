package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/adapters/staticunit"
	"github.com/apache/texera/catalog/internal/adapters/unitmux"
	"github.com/apache/texera/catalog/internal/api"
)

// A profile is what a computing node is made of: its size and the packages it adds to the
// runtime. A unit is made from one; a unit is saved as one, as the next version of a profile
// the caller may change or as a new profile, its packages pinned as installed.

func nodeOf(t *testing.T, unit envelope) api.ComputingNodeSpec {
	t.Helper()
	var spec api.ComputingUnitSpec
	mustDecode(t, unit.Spec, &spec)
	if spec.ComputingNodes == nil || len(*spec.ComputingNodes) == 0 {
		t.Fatalf("the unit has no node: %s", unit.Spec)
	}
	return (*spec.ComputingNodes)[0]
}

func TestAUnitIsMadeFromAProfile(t *testing.T) {
	h := newHarness(t)
	profile := h.create("alice", "profiles", "small with humanize", map[string]any{"cpu": "2", "memory": "4Gi", "packages": []string{"humanize"}})
	var unit envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "from a profile", "profile": string(profile.Metadata.Uri)}, &unit)
	node := nodeOf(t, unit)
	if node.Profile == nil || string(*node.Profile) != string(profile.Metadata.Uri)+"@1" {
		t.Fatalf("the node names the profile's version: %+v", node.Profile)
	}
	if node.Cpu == nil || *node.Cpu != "2" || node.Memory == nil || *node.Memory != "4Gi" || node.Packages == nil || (*node.Packages)[0] != "humanize" {
		t.Fatalf("the node is the profile's: %+v", node)
	}
	// Waited for, a unit that is not ready when the time is up is answered as it is then.
	started := time.Now()
	var waited envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "waited for", "profile": string(profile.Metadata.Uri), "waitSeconds": 1}, &waited)
	var status api.ComputingUnitStatus
	mustDecode(t, waited.Status, &status)
	if status.Phase != api.ComputingUnitStatusPhasePending || time.Since(started) < time.Second {
		t.Fatalf("a unit waited for: %s after %s", status.Phase, time.Since(started))
	}
	// A profile that is not there, or not the caller's to read, makes no unit.
	// With no name of its own, a unit is called after its profile.
	var unnamed envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"profile": string(profile.Metadata.Uri)}, &unnamed)
	if want := profile.Metadata.Name + " unit"; unnamed.Metadata.Name != want {
		t.Fatalf("a unit with no name is called %q, not %q", unnamed.Metadata.Name, want)
	}
	wantError(t, h, "POST", p+"/computing-units/from-profile", map[string]any{"name": "nowhere", "profile": "texera://profiles/00000000-0000-4000-8000-000000000099"}, http.StatusNotFound, "not_found", "")
}

func TestAUnitIsSavedAsAProfile(t *testing.T) {
	h := newHarness(t)
	// A run on the deployment's unit installs the platform profile's packages.
	_, exec := anExecution(t, h)
	finish(t, h, exec, "completed")
	var spec api.ExecutionSpec
	mustDecode(t, exec.Spec, &spec)
	unitRID := strings.TrimPrefix(string(spec.ComputingUnit), "texera://computing-units/")

	// As a new profile: its packages pinned as the unit installed them.
	var mine envelope
	h.mustJSON("alice", "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{"name": "like the deployment's"}, &mine)
	var saved api.ProfileSpec
	mustDecode(t, mine.Spec, &saved)
	if saved.Packages == nil || strings.Join(*saved.Packages, ",") != "numpy==1.0,pandas==1.0,scikit-learn==1.7.2" {
		t.Fatalf("the packages are saved pinned: %+v", saved.Packages)
	}
	// A new profile needs a name.
	wantError(t, h, "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{}, http.StatusBadRequest, "invalid", "needs a name")
	// Texera's profile is its admins' to change: alice does not save over it.
	var unit envelope
	h.mustJSON("alice", "GET", p+"/computing-units/"+unitRID, nil, &unit)
	texeras := nodeOf(t, unit).Profile
	wantError(t, h, "POST", p+"/computing-units/"+unitRID+"/profile", map[string]any{"profile": strings.SplitN(string(*texeras), "@", 2)[0]}, http.StatusForbidden, "forbidden", "may not")

	// As the next version of a profile of one's own; a unit made from it is then made from that version.
	var own envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "mine to save", "profile": string(mine.Metadata.Uri)}, &own)
	var next envelope
	h.mustJSON("alice", "POST", p+"/computing-units/"+rid(own)+"/profile", map[string]any{"profile": string(mine.Metadata.Uri)}, &next)
	if next.Metadata.Head != 2 {
		t.Fatalf("saved as the next version: head %d", next.Metadata.Head)
	}
	h.mustJSON("alice", "GET", p+"/computing-units/"+rid(own), nil, &own)
	if got := nodeOf(t, own).Profile; got == nil || string(*got) != string(mine.Metadata.Uri)+"@2" {
		t.Fatalf("the unit is made from what was saved: %v", got)
	}
}

// What a unit installed was for its packages: given other packages it has none of them
// installed until a run installs them; another size changes nothing of it.
func TestAUnitGivenOtherPackagesHasNothingInstalled(t *testing.T) {
	h := newHarness(t)
	profile := h.create("alice", "profiles", "with humanize", map[string]any{"memory": "2Gi", "packages": []string{"humanize"}})
	var unit envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "mine", "profile": string(profile.Metadata.Uri)}, &unit)
	if _, err := h.svc.Store.MergeStatus(context.Background(), uuid.MustParse(rid(unit)), json.RawMessage(`{"installed": ["humanize==4.11.0"]}`)); err != nil {
		t.Fatal(err)
	}
	installed := func() *[]string {
		var u envelope
		h.mustJSON("alice", "GET", p+"/computing-units/"+rid(unit), nil, &u)
		var status api.ComputingUnitStatus
		mustDecode(t, u.Status, &status)
		return status.Installed
	}
	put := func(node api.ComputingNodeSpec) {
		spec := api.ComputingUnitSpec{Provider: api.UnitProviderKubernetes, ComputingNodes: &[]api.ComputingNodeSpec{node}}
		h.mustJSON("alice", "PUT", p+"/computing-units/"+rid(unit), map[string]any{"spec": spec}, nil)
	}
	node := nodeOf(t, unit)
	bigger := "4Gi"
	node.Memory = &bigger
	put(node)
	if got := installed(); got == nil || len(*got) != 1 {
		t.Fatalf("another size keeps what was installed: %v", got)
	}
	more := append(*node.Packages, "tqdm")
	node.Packages = &more
	put(node)
	if got := installed(); got != nil {
		t.Fatalf("other packages have nothing installed yet: %v", *got)
	}
}

// A profile says, when read, whether this deployment can start a unit from it: everywhere the
// person or the agent finds it, its list, its page and a search.
func TestAProfileSaysWhetherThisDeploymentCanStartIt(t *testing.T) {
	h := newHarness(t)
	var listed api.ResourcePage
	h.mustJSON("alice", "GET", p+"/profiles?limit=50", nil, &listed)
	names := map[string]bool{}
	for _, it := range listed.Items {
		names[it.Metadata.Name] = true
		if (*it.Status)["startable"] != true {
			t.Fatalf("%s should start where units of every kind start: %v", it.Metadata.Name, it.Status)
		}
	}
	for _, rung := range []string{"Small", "Medium", "Large", "ML", "GPU"} {
		if !names[rung] {
			t.Fatalf("the ladder lacks %s: %v", rung, names)
		}
	}
	// A deployment of static units only, as on Compose: no profile can start.
	h.svc.Units = unitmux.Mux{api.UnitProviderStatic: staticunit.Provider{}}
	var gpu api.ResourcePage
	h.mustJSON("alice", "GET", p+"/resources?kind=profile&q=GPU&limit=5", nil, &gpu)
	if len(gpu.Items) == 0 || (*gpu.Items[0].Status)["startable"] != false || (*gpu.Items[0].Status)["notHere"] != "this deployment starts no units from profiles: its own unit runs everything" {
		t.Fatalf("a search finds the GPU profile not startable here, saying why: %+v", gpu.Items)
	}
	var one envelope
	h.mustJSON("alice", "GET", p+"/profiles/"+gpu.Items[0].Metadata.Rid, nil, &one)
	if (*one.Status)["startable"] != false {
		t.Fatalf("its page says so too: %v", one.Status)
	}
}

// On a deployment with no Kubernetes, as on Compose, a unit made from a profile is the
// deployment's own unit with the profile's packages: every rung but the GPU starts, none is
// held to its size, and a GPU unit is refused with the reason before anything is made.
func TestWithoutKubernetesAUnitFromAProfileIsTheDeploymentsOwn(t *testing.T) {
	h := newHarness(t)
	h.svc.Units = unitmux.Mux{api.UnitProviderStatic: staticunit.Provider{}}
	h.svc.Config.ProfileUnits = api.UnitProviderStatic
	var listed api.ResourcePage
	h.mustJSON("alice", "GET", p+"/profiles?limit=50", nil, &listed)
	byName := map[string]envelope{}
	for _, it := range listed.Items {
		byName[it.Metadata.Name] = it
		status := *it.Status
		if status["sized"] != false {
			t.Fatalf("%s says it is held to its size where it is not: %v", it.Metadata.Name, status)
		}
		want := it.Metadata.Name != "GPU"
		if status["startable"] != want {
			t.Fatalf("%s startable %v, want %v: %v", it.Metadata.Name, status["startable"], want, status)
		}
	}
	if why := (*byName["GPU"].Status)["notHere"]; why != "no GPU here: a unit from a profile is this deployment's own unit" {
		t.Fatalf("the GPU rung says why it cannot start: %v", why)
	}

	small := byName["Small"]
	var made envelope
	h.mustJSON("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "small unit", "profile": small.Metadata.Uri, "waitSeconds": 5}, &made)
	var spec api.ComputingUnitSpec
	mustDecode(t, made.Spec, &spec)
	if spec.Provider != api.UnitProviderStatic || spec.Endpoint == nil || *spec.Endpoint != h.svc.Config.StaticUnitEndpoint || spec.ClientId == nil || *spec.ClientId != "texera-unit" {
		t.Fatalf("the unit is the deployment's own: %+v", spec)
	}
	var smallSpec api.ProfileSpec
	mustDecode(t, small.Spec, &smallSpec)
	node := (*spec.ComputingNodes)[0]
	if node.Profile == nil || string(*node.Profile) != string(small.Metadata.Uri)+"@1" || node.Packages == nil || len(*node.Packages) != len(*smallSpec.Packages) {
		t.Fatalf("with the profile's packages, its version named: %+v", node)
	}
	if phase := (*made.Status)["phase"]; phase != "ready" {
		t.Fatalf("it is ready at once, as the deployment's unit is: %v", made.Status)
	}

	status, body := h.do("alice", "POST", p+"/computing-units/from-profile", map[string]any{"name": "gpu unit", "profile": byName["GPU"].Metadata.Uri})
	if status != http.StatusConflict || !strings.Contains(string(body), "no GPU here") {
		t.Fatalf("a GPU unit is refused, saying why: %d %s", status, body)
	}
	var units api.ResourcePage
	h.mustJSON("alice", "GET", p+"/computing-units?limit=50", nil, &units)
	for _, u := range units.Items {
		if u.Metadata.Name == "gpu unit" {
			t.Fatalf("nothing was made for it: %+v", u.Metadata)
		}
	}
}
