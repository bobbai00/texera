package server

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeOperatorsAcceptsContractAndLegacyShapes(t *testing.T) {
	contract := []byte(`{"operators":[{"operatorType":"CSVFileScan","userFriendlyName":"CSV File Scan","operatorGroupName":"Data Input",
		"operatorDescription":"Scan a CSV","jsonSchema":{"properties":{"fileName":{}}},"inputPorts":[],"outputPorts":[{}],"version":"abc"}],"groups":[{"groupName":"Data Input"}]}`)
	list, err := normalizeOperators(contract)
	require.NoError(t, err)
	require.Len(t, list.Operators, 1)
	op := list.Operators[0]
	require.Equal(t, "CSVFileScan", op.OperatorType)
	require.Equal(t, "CSV File Scan", op.UserFriendlyName)
	require.Equal(t, "Data Input", op.OperatorGroupName)
	require.Equal(t, "Scan a CSV", *op.OperatorDescription)
	require.Len(t, op.OutputPorts, 1)
	require.Len(t, list.Groups, 1)

	legacy := []byte(`{"operators":[{"operatorType":"Filter","jsonSchema":{},"operatorVersion":"v1",
		"additionalMetadata":{"userFriendlyName":"Filter","operatorGroupName":"Search","inputPorts":[{}],"outputPorts":[{}]}}],"groups":[]}`)
	list, err = normalizeOperators(legacy)
	require.NoError(t, err)
	require.Equal(t, "Filter", list.Operators[0].UserFriendlyName)
	require.Equal(t, "Search", list.Operators[0].OperatorGroupName)
	require.Equal(t, "v1", *list.Operators[0].Version)
}
