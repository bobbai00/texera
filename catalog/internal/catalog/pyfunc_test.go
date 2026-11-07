package catalog

import (
	"encoding/json"
	"strings"
	"testing"
)

const cgmMetrics = `import pandas as pd

# A helper the operator's function uses; it is not an operator.
def _share(s, low, high):
    return s.between(low, high).mean()


@returns(patient_id=str, time_in_range=float, mean_glucose=float, readings=int)
def cgm_metrics(readings: pd.DataFrame, *, tir_low: int = 70, tir_high: int = 180) -> pd.DataFrame:
    """Time in range and mean glucose, one row per patient.

    Readings outside the sensor's range count as they are.
    """
    g = readings.groupby("patient_id")["glucose"]
    return pd.DataFrame({
        "time_in_range": g.apply(lambda s: _share(s, tir_low, tir_high)),
        "mean_glucose": g.mean(),
        "readings": g.size(),
    }).reset_index()
`

func TestAFunctionsDefinitionSaysItsOperator(t *testing.T) {
	fn, err := parsePyFunction(cgmMetrics, "cgm_metrics")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(fn.Inputs, ",") != "readings" {
		t.Fatalf("inputs: %v", fn.Inputs)
	}
	got, _ := json.Marshal(fn.Settings)
	want := `[{"Name":"tir_low","Schema":{"default":70,"type":"integer"},"Required":false},{"Name":"tir_high","Schema":{"default":180,"type":"integer"},"Required":false}]`
	if string(got) != want {
		t.Fatalf("settings: %s", got)
	}
	returns, _ := json.Marshal(fn.Returns)
	if string(returns) != `[{"attributeName":"patient_id","attributeType":"string"},{"attributeName":"time_in_range","attributeType":"double"},{"attributeName":"mean_glucose","attributeType":"double"},{"attributeName":"readings","attributeType":"long"}]` {
		t.Fatalf("returns: %s", returns)
	}
	if fn.Doc != "Time in range and mean glucose, one row per patient.\n\nReadings outside the sensor's range count as they are." {
		t.Fatalf("doc: %q", fn.Doc)
	}
}

func TestAFunctionsSettingsTakeTheirTypeFromTheAnnotationElseTheDefault(t *testing.T) {
	code := `@returns(
    patient_id="string",   # a Texera type name works too
    risk=float,
    flagged=bool,
    at=datetime,
)
def score(labs, readings, /, threshold: Optional[float] = None, *, units="mg/dL", keys: list[str] = ["patient_id"],
          strict: bool = True, offset=-1.5, weights=(1, 2), mode: str) -> pd.DataFrame:
    return labs
`
	fn, err := parsePyFunction(code, "score")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(fn.Inputs, ",") != "labs,readings" {
		t.Fatalf("inputs: %v", fn.Inputs)
	}
	got := map[string]string{}
	for _, s := range fn.Settings {
		b, _ := json.Marshal(s.Schema)
		got[s.Name] = string(b)
		if s.Required != (s.Name == "mode") {
			t.Errorf("%s required: %v", s.Name, s.Required)
		}
	}
	want := map[string]string{
		"threshold": `{"type":"number"}`,
		"units":     `{"default":"mg/dL","type":"string"}`,
		"keys":      `{"default":["patient_id"],"items":{"type":"string"},"type":"array"}`,
		"strict":    `{"default":true,"type":"boolean"}`,
		"offset":    `{"default":-1.5,"type":"number"}`,
		"weights":   `{"default":[1,2],"items":{"type":"integer"},"type":"array"}`,
		"mode":      `{"type":"string"}`,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %s, want %s", k, got[k], v)
		}
	}
	if len(fn.Returns) != 4 || fn.Returns[0].AttributeType != "string" || fn.Returns[3].AttributeType != "timestamp" {
		t.Fatalf("returns: %+v", fn.Returns)
	}
	if fn.Doc != "" {
		t.Fatalf("doc: %q", fn.Doc)
	}
}

func TestWhatIsWrongWithAFunctionIsSaidOnItsLine(t *testing.T) {
	cases := map[string]string{
		"def f(x):\n    return x\n":                                    "f has no @returns: name its output columns and their types above it, as @returns(patient_id=str, mean=float)",
		"@returns(a=str)\ndef g(x):\n    return x\n":                   "the code has no function f at its top level",
		"@returns(a=str)\ndef f(*tables):\n    return x\n":             "line 2: f takes no *tables: name each input and each setting",
		"@returns(a=str)\ndef f(x, **options):\n    return x\n":        "line 2: f takes no **options: name each input and each setting",
		"@returns(a=str)\ndef f(x, *, by=['a']):\n    return x\n":      "line 2: by is the setting that groups an operator's rows; name yours otherwise",
		"@returns(a=str)\ndef f(x, *, n=len('a')):\n    return x\n":    "line 2: setting n: its default must be a number, text, True, False, None or a list of them",
		"@returns(a=str)\ndef f(x, *, n):\n    return x\n":             "line 2: setting n: say its type, as n: int = 0",
		"@returns(a=decimal)\ndef f(x):\n    return x\n":               `line 1: column a: "decimal" is not a column type; use str, int, float, bool or datetime`,
		"@returns(a=str, a=int)\ndef f(x):\n    return x\n":            "line 1: column a is named twice",
		"@returns()\ndef f(x):\n    return x\n":                        "line 1: @returns names no column; f's output needs at least one",
		"@returns(str)\ndef f(x):\n    return x\n":                     "line 1: @returns names each column as name=type, as @returns(patient_id=str, mean=float)",
		"@returns(a=str)\ndef f(*, n: int = 1):\n    return x\n":       "f reads no table: its first parameters are its inputs, as def f(readings, *, ...)",
		"@returns(a=str)\ndef f(x='a', y):\n    return x\n":            "line 2: input y comes after a setting; inputs come first",
		"@returns(a=str)\ndef f(x):\n    s = 'never closed\n":          "line 3: a string is not closed",
		"class C:\n    @returns(a=str)\n    def f(x):\n        pass\n": "the code has no function f at its top level",
		"s = \"def f(x):\"  # def f(x):\n":                             "the code has no function f at its top level",
	}
	for code, want := range cases {
		_, err := parsePyFunction(code, "f")
		if err == nil || err.Error() != want {
			t.Errorf("%q:\n got  %v\n want %s", code, err, want)
		}
	}
}

func TestSavingAFunctionOperatorFillsItsSpecFromItsCode(t *testing.T) {
	doc := map[string]any{"implementation": map[string]any{"python": map[string]any{"code": cgmMetrics, "function": "cgm_metrics"}}}
	if err := functionOperator(doc); err != nil {
		t.Fatal(err)
	}
	if doc["operatorType"] != "cgm_metrics" || !strings.HasPrefix(doc["description"].(string), "Time in range") {
		t.Fatalf("type and description: %v %v", doc["operatorType"], doc["description"])
	}
	ports, _ := json.Marshal([]any{doc["inputPorts"], doc["outputPorts"]})
	if string(ports) != `[[{"portID":"input-0"}],[{"portID":"output-0"}]]` {
		t.Fatalf("ports: %s", ports)
	}
	schema, _ := json.Marshal(doc["propertiesSchema"])
	for _, want := range []string{`"by":{"description":"The columns whose rows reach one call together`, `"tir_low":{"default":70,"propertyOrder":1,"type":"integer"}`, `"tir_high":{"default":180,"propertyOrder":2,"type":"integer"}`} {
		if !strings.Contains(string(schema), want) {
			t.Errorf("schema %s lacks %s", schema, want)
		}
	}
	columns, _ := json.Marshal(doc["implementation"].(map[string]any)["python"].(map[string]any)["outputColumns"])
	if !strings.HasPrefix(string(columns), `[{"attributeName":"patient_id","attributeType":"string"},`) {
		t.Fatalf("columns: %s", columns)
	}

	// A name given stays; two inputs are named by their parameters; a class is left as it is.
	named := map[string]any{"operatorType": "CGM metrics", "description": "mine", "implementation": map[string]any{"python": map[string]any{
		"code": "@returns(n=int)\ndef pair(left, right):\n    return left\n", "function": "pair"}}}
	if err := functionOperator(named); err != nil {
		t.Fatal(err)
	}
	two, _ := json.Marshal(named["inputPorts"])
	if named["operatorType"] != "CGM metrics" || named["description"] != "mine" || string(two) != `[{"displayName":"left","portID":"input-0"},{"displayName":"right","portID":"input-1"}]` {
		t.Fatalf("named: %v %v %s", named["operatorType"], named["description"], two)
	}
	class := map[string]any{"implementation": map[string]any{"python": map[string]any{"code": "class X: pass"}}}
	if err := functionOperator(class); err != nil || class["inputPorts"] != nil {
		t.Fatalf("a class changed: %v %v", err, class)
	}
}
