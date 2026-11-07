package uri

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/kinds"
)

const (
	rid1 = "8f3a0b1e-7c2d-4e5f-9a6b-1c2d3e4f5a6b"
	rid2 = "91000000-0000-4000-8000-000000000091"
)

func TestRoundTrip(t *testing.T) {
	names := []string{
		"texera://workflows/" + rid1,
		"texera://workflows/" + rid1 + "@3",
		"texera://datasets/" + rid1 + "@2/files/iris.csv",
		"texera://datasets/" + rid1 + "@2/files/dir/with/slashes.csv",
		"texera://workflows/" + rid1 + "/executions/" + rid2,
		"texera://workflows/" + rid1 + "/executions/" + rid2 + "/operators/agg/ports/output-0",
		"texera://computing-units/" + rid1 + "/computing-nodes/w-gpu",
		"texera://conversations/" + rid1 + "/messages/17",
		"texera://agent-templates/" + rid1 + "@5",
		"texera://projects/" + rid1,
	}
	for _, name := range names {
		r, err := Parse(name)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if got := r.String(); got != name {
			t.Errorf("%s: printed as %s", name, got)
		}
		again, err := Parse(r.String())
		if err != nil || !reflect.DeepEqual(again, r) {
			t.Errorf("%s: second parse differs: %+v vs %+v (%v)", name, again, r, err)
		}
	}
}

func TestParseFields(t *testing.T) {
	r, err := Parse("texera://workflows/" + rid1 + "/executions/" + rid2 + "/operators/agg/ports/output-0")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind.Name != "execution" || r.Rid != rid2 || r.Parent != rid1 || r.Subresource != "operators/agg/ports/output-0" {
		t.Errorf("unexpected parse: %+v", r)
	}
	if got := r.Path("/catalog/v1"); got != "/catalog/v1/workflows/"+rid1+"/executions/"+rid2+"/operators/agg/ports/output-0" {
		t.Errorf("path: %s", got)
	}

	v, err := Parse("texera://datasets/" + rid1 + "@2/files/iris.csv")
	if err != nil {
		t.Fatal(err)
	}
	if v.Kind.Name != "dataset" || v.Vno != 2 || v.Subresource != "files/iris.csv" {
		t.Errorf("unexpected parse: %+v", v)
	}
	if got := v.Path("/catalog/v1"); got != "/catalog/v1/datasets/"+rid1+"/versions/2/files/iris.csv" {
		t.Errorf("path: %s", got)
	}
	if got := v.Resource().String(); got != "texera://datasets/"+rid1 {
		t.Errorf("resource: %s", got)
	}

	// The REST spelling of a version parses to the same name.
	rest, err := Parse("texera://workflows/" + rid1 + "/versions/3")
	if err != nil || rest.Vno != 3 || rest.String() != "texera://workflows/"+rid1+"@3" {
		t.Errorf("rest spelling: %+v %v", rest, err)
	}

	if _, err := Parse("texera://settings"); err == nil {
		t.Error("texera://settings names nothing: the deployment's settings are Texera's, a project's")
	}
}

func TestParseRejects(t *testing.T) {
	bad := []string{
		"",
		"dataset://" + rid1,
		"texera://",
		"texera://widgets/" + rid1,
		"texera://workflows",
		"texera://workflows/not-a-uuid",
		"texera://workflows/" + rid1 + "@0",
		"texera://workflows/" + rid1 + "@x",
		"texera://executions/" + rid1 + "@1",
		"texera://conversations/" + rid1 + "@2",
		"texera://datasets/" + rid1 + "//files",
	}
	for _, name := range bad {
		if _, err := Parse(name); err == nil {
			t.Errorf("%q: accepted", name)
		}
	}
}

func TestBuild(t *testing.T) {
	wf, _ := kinds.ByName("workflow")
	ex, _ := kinds.ByName("execution")
	if got := Of(wf, rid1).WithVersion(3).String(); got != "texera://workflows/"+rid1+"@3" {
		t.Error(got)
	}
	if got := Nested(ex, rid1, rid2).With("operators", "agg", "ports", "output-0").String(); !strings.HasSuffix(got, "/ports/output-0") {
		t.Error(got)
	}
}

func TestExtract(t *testing.T) {
	var doc any
	spec := `{"operators":[{"operatorID":"scan","operatorType":"texera://operators/` + rid2 + `@1","operatorProperties":{"fileName":"texera://datasets/` + rid1 + `@2/files/iris.csv","note":"texera://nonsense"}}],"defaultComputingUnit":"texera://computing-units/` + rid1 + `"}`
	if err := json.Unmarshal([]byte(spec), &doc); err != nil {
		t.Fatal(err)
	}
	refs := Extract(doc)
	want := map[string]string{
		"/operators/0/operatorType":                "texera://operators/" + rid2 + "@1",
		"/operators/0/operatorProperties/fileName": "texera://datasets/" + rid1 + "@2/files/iris.csv",
		"/defaultComputingUnit":                    "texera://computing-units/" + rid1,
	}
	if len(refs) != len(want) {
		t.Fatalf("got %d refs: %v", len(refs), refs)
	}
	for pointer, name := range want {
		if refs[pointer].String() != name {
			t.Errorf("%s: %s", pointer, refs[pointer])
		}
	}
}
