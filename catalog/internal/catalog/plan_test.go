package catalog

import (
	"testing"

	"github.com/apache/texera/catalog/internal/api"
)

// An operator that lists no ports gets the ones its links use, at least one input unless it
// reads nothing and one output: no link is lost, as the app draws it.
func TestAnOperatorThatListsNoPortsGetsTheOnesItsLinksUse(t *testing.T) {
	link := func(id, from, to, port string) api.WorkflowLink {
		return api.WorkflowLink{LinkID: id, Source: api.WorkflowLinkEnd{OperatorID: from, PortID: "output-0"}, Target: api.WorkflowLinkEnd{OperatorID: to, PortID: port}}
	}
	spec := api.WorkflowSpec{
		Operators: []api.WorkflowOperator{
			{OperatorID: "left", OperatorType: "CSVFileScan"},
			{OperatorID: "right", OperatorType: "CSVFileScan"},
			{OperatorID: "join", OperatorType: "HashJoin"},
			{OperatorID: "alone", OperatorType: "Limit"},
		},
		Links: []api.WorkflowLink{link("l1", "left", "join", "input-0"), link("l2", "right", "join", "input-1")},
	}
	defaultPorts(&spec)
	ids := func(ports *[]api.WorkflowPort) []string {
		var out []string
		if ports != nil {
			for _, p := range *ports {
				out = append(out, p.PortID)
			}
		}
		return out
	}
	if got := ids(spec.Operators[2].InputPorts); len(got) != 2 || got[0] != "input-0" || got[1] != "input-1" {
		t.Fatalf("the join's inputs: %v", got)
	}
	if got := ids(spec.Operators[0].InputPorts); len(got) != 0 {
		t.Fatalf("a scan reads nothing: %v", got)
	}
	if got := ids(spec.Operators[3].InputPorts); len(got) != 1 || got[0] != "input-0" {
		t.Fatalf("an operator with no link still has one input: %v", got)
	}
	if got := ids(spec.Operators[2].OutputPorts); len(got) != 1 || got[0] != "output-0" {
		t.Fatalf("outputs: %v", got)
	}
}
