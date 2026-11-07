package catalog

import (
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/engine"
)

func lop(id, typ string, settings map[string]any) map[string]any {
	op := map[string]any{"operatorID": id, "operatorType": typ, "outputPorts": []any{map[string]any{"portID": "output-0"}}}
	for k, v := range settings {
		op[k] = v
	}
	return op
}

func llink(from, to string, port int) logicalLink {
	return logicalLink{FromOpID: from, FromPortID: portIdentity{ID: 0}, ToOpID: to, ToPortID: portIdentity{ID: port}}
}

const readings = "texera://datasets/11111111-1111-4111-8111-111111111111@4/files/cgm.csv"

// overnight is the demo's shape: a scan, a filter, an aggregate the run keeps, a sort it shows.
func overnight(file string, prefix string) logicalPlan {
	return logicalPlan{
		Operators: []map[string]any{
			lop(prefix+"scan", "scan", map[string]any{"file": file}),
			lop(prefix+"night", "filter", map[string]any{"where": "hour(taken_at) < 6"}),
			lop(prefix+"lows", "aggregate", map[string]any{"by": []any{"patient_id"}, "outputs": []any{"n = count(*)"}}),
			lop(prefix+"ranked", "sort", map[string]any{"by": []any{"n desc"}}),
		},
		Links: []logicalLink{llink(prefix+"scan", prefix+"night", 0), llink(prefix+"night", prefix+"lows", 0), llink(prefix+"lows", prefix+"ranked", 0)},
	}
}

func TestOnlyWhatDependsOnItsInputsAloneIsReusable(t *testing.T) {
	plan := logicalPlan{
		Operators: []map[string]any{
			lop("scan", "scan", nil),
			lop("sorted", "sort", nil),
			lop("top", "limit", map[string]any{"n": 5}),
			lop("some", "limit", map[string]any{"n": 5}),
			lop("one-each", "distinct", map[string]any{"columns": []any{"patient_id"}}),
			lop("unique", "distinct", nil),
			lop("udf", "PythonUDFV2", nil),
			lop("after-udf", "filter", nil),
			lop("metrics", functionType, nil),
			lop("jitter", functionType, nil),
			lop("after-jitter", "filter", nil),
		},
		Links: []logicalLink{
			llink("scan", "sorted", 0), llink("sorted", "top", 0), llink("scan", "some", 0), llink("scan", "one-each", 0), llink("scan", "unique", 0),
			llink("scan", "udf", 0), llink("udf", "after-udf", 0), llink("scan", "metrics", 0), llink("scan", "jitter", 0), llink("jitter", "after-jitter", 0),
		},
	}
	// A function is reused unless it is declared nondeterministic; then neither is what follows it.
	got := reusableOps(plan, map[string]bool{"jitter": true})
	want := map[string]bool{
		"scan": true, "sorted": true, "top": true, "some": false, "one-each": false, "unique": true, "udf": false, "after-udf": false,
		"metrics": true, "jitter": false, "after-jitter": false,
	}
	for id, ok := range want {
		if got[id] != ok {
			t.Errorf("%s reusable: %v, want %v", id, got[id], ok)
		}
	}
}

func TestTheSameWorkHasTheSameFingerprintWhereverItIsDone(t *testing.T) {
	a, b := overnight(readings, "a-"), overnight(readings, "b-")
	fa := fingerprints(a, reusableOps(a, nil), "engine-1", "env-1")
	fb := fingerprints(b, reusableOps(b, nil), "engine-1", "env-1")
	if fa["a-ranked/output-0"] == "" || fa["a-ranked/output-0"] != fb["b-ranked/output-0"] || fa["a-lows/output-0"] != fb["b-lows/output-0"] {
		t.Fatalf("the same work under other ids: %v, %v", fa, fb)
	}
	// Another version of the file, another engine, another setting: other rows.
	c := overnight(strings.Replace(readings, "@4", "@5", 1), "a-")
	if fingerprints(c, reusableOps(c, nil), "engine-1", "env-1")["a-scan/output-0"] == fa["a-scan/output-0"] {
		t.Fatal("a new version of the file made the same scan")
	}
	if fingerprints(a, reusableOps(a, nil), "engine-2", "env-1")["a-scan/output-0"] == fa["a-scan/output-0"] {
		t.Fatal("another engine made the same scan")
	}
	// The Python environment is part only of what runs Python.
	if fingerprints(a, reusableOps(a, nil), "engine-1", "env-2")["a-ranked/output-0"] != fa["a-ranked/output-0"] {
		t.Fatal("the packages changed a sort")
	}
	d := overnight(readings, "a-")
	d.Operators[2]["outputs"] = []any{"n = count(*)", "lows = count_if(glucose < 70)"}
	fd := fingerprints(d, reusableOps(d, nil), "engine-1", "env-1")
	if fd["a-night/output-0"] != fa["a-night/output-0"] || fd["a-lows/output-0"] == fa["a-lows/output-0"] || fd["a-ranked/output-0"] == fa["a-ranked/output-0"] {
		t.Fatal("a changed aggregate should change it and what reads it, and nothing before it")
	}
}

func compiledOf(plan logicalPlan, shown ...string) *compiled {
	c := &compiled{Plan: plan, Custom: map[int]customOp{}, Shown: map[string]bool{}}
	for _, id := range shown {
		c.Shown[portKey(id, "output-0")] = true
		c.Outputs = append(c.Outputs, api.PortTable{OperatorID: id, PortID: "output-0", Table: tableName(id, "output-0")})
	}
	c.Reusable = reusableOps(plan, nil)
	for _, op := range plan.Operators {
		if keptTypes[opType(op)] && !c.Shown[portKey(opID(op), "output-0")] {
			c.Outputs = append(c.Outputs, api.PortTable{OperatorID: opID(op), PortID: "output-0", Table: tableName(opID(op), "output-0")})
			c.Plan.OpsToViewResult = append(c.Plan.OpsToViewResult, opID(op))
		}
	}
	c.Fingerprints = fingerprints(plan, c.Reusable, "engine-1", "")
	return c
}

func stored(from string) *storedRows {
	return &storedRows{From: from, Namespace: "e_old", Table: "t", Columns: []engine.Attribute{{AttributeName: "n", AttributeType: "long"}}}
}

func TestARunReadsWhatWasStoredAndSkipsWhatOnlyFedIt(t *testing.T) {
	c := compiledOf(overnight(readings, ""), "ranked")
	c.Inputs = []inputRef{{URI: readings, Operator: 0, OperatorID: "scan", Pointer: "/file"}}
	c.Secrets = []secretRef{{Operator: 3, Pointer: "/key"}}
	var asked []string
	served, skipped := c.reuse(func(port string) *storedRows {
		asked = append(asked, port)
		if port == "lows/output-0" {
			return stored("texera://workflows/w/executions/e/operators/lows/ports/output-0")
		}
		return nil
	})
	// The sort runs; the aggregate it reads was found; what fed only the aggregate is never asked about.
	if strings.Join(asked, " ") != "ranked/output-0 lows/output-0" {
		t.Fatalf("asked about %v", asked)
	}
	if len(served) != 1 || strings.Join(skipped, " ") != "scan night" {
		t.Fatalf("served %v, skipped %v", served, skipped)
	}
	if len(c.Plan.Operators) != 2 || opType(c.Plan.Operators[0]) != storedType || opID(c.Plan.Operators[0]) != "lows" || c.Plan.Operators[0]["table"] != "t" {
		t.Fatalf("operators: %v", c.Plan.Operators)
	}
	if len(c.Plan.Links) != 1 || c.Plan.Links[0].FromOpID != "lows" || c.Plan.Links[0].ToOpID != "ranked" {
		t.Fatalf("links: %v", c.Plan.Links)
	}
	// Nothing shows the aggregate, so it is read, not copied; the file is not read at all; the
	// sort's credential follows it to its new place.
	if len(c.Outputs) != 1 || c.Outputs[0].OperatorID != "ranked" || len(c.Plan.OpsToViewResult) != 0 {
		t.Fatalf("outputs %v, views %v", c.Outputs, c.Plan.OpsToViewResult)
	}
	if len(c.Inputs) != 0 || len(c.Secrets) != 1 || c.Secrets[0].Operator != 1 {
		t.Fatalf("inputs %v, secrets %v", c.Inputs, c.Secrets)
	}
	if r := reusedRecord(served); len(r) != 1 || r[0].OperatorID != "lows" || !strings.HasSuffix(string(r[0].From), "/operators/lows/ports/output-0") {
		t.Fatalf("record: %v", r)
	}
}

func TestAShownResultFoundIsCopiedAndNothingElseRuns(t *testing.T) {
	c := compiledOf(overnight(readings, ""), "ranked")
	served, skipped := c.reuse(func(port string) *storedRows {
		return stored("texera://workflows/w/executions/e/operators/" + strings.TrimSuffix(port, "/output-0") + "/ports/output-0")
	})
	if len(served) != 1 || strings.Join(skipped, " ") != "scan night lows" {
		t.Fatalf("served %v, skipped %v", served, skipped)
	}
	if len(c.Plan.Operators) != 1 || opType(c.Plan.Operators[0]) != storedType || len(c.Outputs) != 1 || c.Outputs[0].OperatorID != "ranked" {
		t.Fatalf("plan %v, outputs %v", c.Plan.Operators, c.Outputs)
	}
}

func TestWhatIsNotFoundOrNotReusableRunsAsItWas(t *testing.T) {
	c := compiledOf(overnight(readings, ""), "ranked")
	before := len(c.Plan.Operators)
	served, skipped := c.reuse(func(string) *storedRows { return nil })
	if len(served) != 0 || len(skipped) != 0 || len(c.Plan.Operators) != before {
		t.Fatalf("nothing found changed the plan: %v %v", served, skipped)
	}
	// A limit with no sort before it is made again, though its rows were stored.
	plan := logicalPlan{Operators: []map[string]any{lop("scan", "scan", nil), lop("some", "limit", map[string]any{"n": 3})}, Links: []logicalLink{llink("scan", "some", 0)}}
	d := compiledOf(plan, "some")
	asked := 0
	d.reuse(func(string) *storedRows { asked++; return stored("x") })
	if asked != 0 || d.Fingerprints["some/output-0"] != "" {
		t.Fatalf("a limit with no sort before it was looked up: %d", asked)
	}
}
