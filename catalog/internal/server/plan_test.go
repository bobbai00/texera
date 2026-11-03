package server

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestContentToLogicalPlan(t *testing.T) {
	raw := json.RawMessage(`{
	  "operators": [
	    {"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": {"fileName": "dataset://abc@2/iris.csv", "hasHeader": true}},
	    {"operatorID": "filter", "operatorType": "Filter", "operatorProperties": {"predicates": []},
	     "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}], "viewResult": true},
	    {"operatorID": "off", "operatorType": "Filter", "operatorProperties": {}, "isDisabled": true}
	  ],
	  "links": [
	    {"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "filter", "portID": "input-0"}},
	    {"linkID": "l2", "source": {"operatorID": "filter", "portID": "output-0"}, "target": {"operatorID": "off", "portID": "input-0"}}
	  ]}`)
	c, err := ParseContent(raw)
	require.NoError(t, err)
	require.NoError(t, c.Validate())
	require.Empty(t, c.Operators[0].InputPorts, "a scan has no input ports")
	require.Len(t, c.Operators[0].OutputPorts, 1)

	plan := c.ToLogicalPlan()
	require.Len(t, plan.Operators, 2, "disabled operators are dropped")
	require.Len(t, plan.Links, 1, "links to disabled operators are dropped")
	require.Equal(t, "scan", plan.Operators[0]["operatorID"])
	require.Equal(t, "CSVFileScan", plan.Operators[0]["operatorType"])
	require.Equal(t, true, plan.Operators[0]["hasHeader"])
	require.Equal(t, LogicalLink{FromOpID: "scan", FromPortID: PortIdentity{ID: 0}, ToOpID: "filter", ToPortID: PortIdentity{ID: 0}}, plan.Links[0])
	require.Equal(t, []string{"filter"}, plan.OpsToViewResult)

	refs := FindDatasetRefs(c.Operators[0].OperatorProperties)
	require.Equal(t, map[string]DatasetRef{"fileName": {RID: "abc", Vno: 2, Path: "iris.csv"}}, refs)
	SetProperty(c.Operators[0].OperatorProperties, "fileName", "https://example/iris.csv")
	require.Equal(t, "https://example/iris.csv", c.Operators[0].OperatorProperties["fileName"])
}

func TestValidateRejectsDanglingLinks(t *testing.T) {
	c, err := ParseContent(json.RawMessage(`{"operators":[{"operatorID":"a","operatorType":"Filter"}],
		"links":[{"linkID":"l","source":{"operatorID":"a","portID":"output-0"},"target":{"operatorID":"b","portID":"input-0"}}]}`))
	require.NoError(t, err)
	require.Error(t, c.Validate())
}

func TestParseDatasetURI(t *testing.T) {
	ref, ok := ParseDatasetURI("dataset://rid-1/dir/file.csv")
	require.True(t, ok)
	require.Equal(t, DatasetRef{RID: "rid-1", Vno: 0, Path: "dir/file.csv"}, ref)
	_, ok = ParseDatasetURI("/local/file.csv")
	require.False(t, ok)
	require.Equal(t, "dataset://rid-1@3/a.csv", DatasetRef{RID: "rid-1", Vno: 3, Path: "a.csv"}.String())
}
