package kinds

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTableIsComplete(t *testing.T) {
	var bundle struct {
		Defs map[string]json.RawMessage `json:"$defs"`
	}
	if err := json.Unmarshal(Bundle(), &bundle); err != nil {
		t.Fatal(err)
	}
	if len(Table) != 15 {
		t.Fatalf("expected 15 kinds, got %d", len(Table))
	}
	for _, k := range Table {
		if _, ok := bundle.Defs[k.Spec]; !ok {
			t.Errorf("%s: spec schema %s missing from the bundle", k.Name, k.Spec)
		}
		if k.Status != "" {
			if _, ok := bundle.Defs[k.Status]; !ok {
				t.Errorf("%s: status schema %s missing from the bundle", k.Name, k.Status)
			}
		}
		if _, ok := bundle.Defs[k.Envelope]; !ok {
			t.Errorf("%s: envelope schema %s missing from the bundle", k.Name, k.Envelope)
		}
		if k.Parent != "" {
			if _, ok := ByName(k.Parent); !ok {
				t.Errorf("%s: parent kind %s unknown", k.Name, k.Parent)
			}
		}
		if got, ok := ByPlural(k.Plural); !ok || got.Name != k.Name {
			t.Errorf("%s: ByPlural(%s) = %v, %v", k.Name, k.Plural, got.Name, ok)
		}
	}
}

func TestValidateSpec(t *testing.T) {
	wf, _ := ByName("workflow")
	good := `{"operators":[{"operatorID":"scan","operatorType":"CSVFileScan","operatorProperties":{"fileName":"texera://datasets/1@1/files/iris.csv"}}],"links":[]}`
	if err := wf.ValidateSpec(json.RawMessage(good)); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	bad := `{"operators":[{"operatorType":"CSVFileScan"}]}`
	err := wf.ValidateSpec(json.RawMessage(bad))
	if err == nil {
		t.Fatal("invalid spec accepted")
	}
	var ve *ValidationError
	if !errorsAsValidation(err, &ve) {
		t.Fatalf("expected a ValidationError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "WorkflowSpec") {
		t.Errorf("error should name the schema: %v", err)
	}

	cu, _ := ByName("computing-unit")
	if err := cu.ValidateSpec(json.RawMessage(`{"provider":"static","endpoint":"http://localhost:28085"}`)); err != nil {
		t.Fatalf("valid unit spec rejected: %v", err)
	}
	if err := cu.ValidateSpec(json.RawMessage(`{"provider":"cloud"}`)); err == nil {
		t.Fatal("unknown provider accepted")
	}
	if err := cu.ValidateStatus(json.RawMessage(`{"phase":"ready"}`)); err != nil {
		t.Fatalf("valid status rejected: %v", err)
	}
}

func errorsAsValidation(err error, target **ValidationError) bool {
	for err != nil {
		if ve, ok := err.(*ValidationError); ok {
			*target = ve
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
