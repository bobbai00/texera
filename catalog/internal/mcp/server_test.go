package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/store"
)

// fakeImpl implements only the operations the tests call; the rest panic.
type fakeImpl struct {
	api.StrictServerInterface
	created *api.CreateWorkflowWithContent
}

func (f *fakeImpl) WorkflowsCreateWithContent(_ context.Context, req api.WorkflowsCreateWithContentRequestObject) (api.WorkflowsCreateWithContentResponseObject, error) {
	f.created = req.Body
	return api.WorkflowsCreateWithContent200JSONResponse(api.WorkflowWithVersion{Version: api.ResourceVersion{Rid: "wf-1", Vno: 1}}), nil
}

func (f *fakeImpl) DatasetsDownload(_ context.Context, _ api.DatasetsDownloadRequestObject) (api.DatasetsDownloadResponseObject, error) {
	return api.DatasetsDownload200ApplicationoctetStreamResponse{Body: strings.NewReader("a,b\n1,2\n"), ContentLength: 8}, nil
}

func (f *fakeImpl) ResourcesRead(_ context.Context, _ api.ResourcesReadRequestObject) (api.ResourcesReadResponseObject, error) {
	return nil, errors.New("forbidden: the caller may not perform this action")
}

func connect(t *testing.T, impl api.StrictServerInterface) *sdk.ClientSession {
	t.Helper()
	server := sdk.NewServer(&sdk.Implementation{Name: "texera", Version: "test"}, nil)
	caller := &authn.Caller{Principal: &store.Principal{Kind: "user", DisplayName: "alice"}}
	wrap := func(ctx context.Context, _ *sdk.CallToolRequest) (context.Context, error) {
		return authn.WithCaller(ctx, caller), nil
	}
	registerTools(server, impl, wrap, finish)
	ct, st := sdk.NewInMemoryTransports()
	ctx := context.Background()
	_, err := server.Connect(ctx, st, nil)
	require.NoError(t, err)
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "test"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestToolSchemasAreTyped(t *testing.T) {
	cs := connect(t, &fakeImpl{})
	tools, err := cs.ListTools(context.Background(), nil)
	require.NoError(t, err)
	byName := map[string]*sdk.Tool{}
	for _, tool := range tools.Tools {
		byName[tool.Name] = tool
	}
	require.Contains(t, byName, "create_workflow")
	require.Contains(t, byName, "run_workflow")
	require.True(t, byName["get_workflow"].Annotations.ReadOnlyHint)
	schema, err := json.Marshal(byName["create_workflow"].InputSchema)
	require.NoError(t, err)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(schema, &parsed))
	content := parsed["properties"].(map[string]any)["content"].(map[string]any)
	require.Contains(t, content["properties"], "operators", "workflow content is a typed object, not 'any'")
}

func TestCreateWorkflowPassesTypedContent(t *testing.T) {
	impl := &fakeImpl{}
	cs := connect(t, impl)
	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: "create_workflow", Arguments: map[string]any{
		"name": "wf",
		"content": map[string]any{
			"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": "dataset://d@1/a.csv"}}},
			"links":     []any{},
		},
	}})
	require.NoError(t, err)
	require.False(t, res.IsError)
	require.NotNil(t, impl.created)
	require.Equal(t, "CSVFileScan", impl.created.Content.Operators[0].OperatorType)
}

func TestFileReadsReturnText(t *testing.T) {
	cs := connect(t, &fakeImpl{})
	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: "read_dataset_file", Arguments: map[string]any{"rid": "d", "vno": 1, "path": "a.csv"}})
	require.NoError(t, err)
	require.False(t, res.IsError)
	require.Equal(t, "a,b\n1,2\n", res.Content[0].(*sdk.TextContent).Text)
}

func TestHandlerErrorsBecomeToolErrors(t *testing.T) {
	cs := connect(t, &fakeImpl{})
	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: "get_resource", Arguments: map[string]any{"rid": "x"}})
	require.NoError(t, err)
	require.True(t, res.IsError)
	require.Contains(t, res.Content[0].(*sdk.TextContent).Text, "forbidden")
}

func (f *fakeImpl) OperatorsList(_ context.Context, _ api.OperatorsListRequestObject) (api.OperatorsListResponseObject, error) {
	schema := map[string]any{"properties": map[string]any{"fileName": map[string]any{"type": "string"}}}
	return api.OperatorsList200JSONResponse(api.OperatorTypeList{Operators: []api.OperatorType{
		{OperatorType: "CSVFileScan", UserFriendlyName: "CSV File Scan", OperatorGroupName: "Data Input", JsonSchema: schema, OutputPorts: []interface{}{map[string]any{"id": 0}}},
		{OperatorType: "Aggregate", UserFriendlyName: "Aggregate", OperatorGroupName: "Data Cleaning", JsonSchema: schema, InputPorts: []interface{}{map[string]any{"id": 0}}},
	}}), nil
}

func TestBareListOperatorsIsCompact(t *testing.T) {
	cs := connect(t, compactOperators{&fakeImpl{}})
	operators := func(args map[string]any) []map[string]any {
		res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: "list_operators", Arguments: args})
		require.NoError(t, err)
		require.False(t, res.IsError)
		var body struct {
			Operators []map[string]any `json:"operators"`
		}
		require.NoError(t, json.Unmarshal([]byte(res.Content[0].(*sdk.TextContent).Text), &body))
		return body.Operators
	}
	bare := operators(map[string]any{})
	require.Len(t, bare, 2)
	require.Equal(t, "CSVFileScan", bare[0]["operatorType"])
	require.Equal(t, "Data Input", bare[0]["operatorGroupName"])
	require.Nil(t, bare[0]["jsonSchema"])
	require.Nil(t, bare[0]["outputPorts"])
	narrowed := operators(map[string]any{"q": "csv"})
	require.NotNil(t, narrowed[0]["jsonSchema"])
	require.NotNil(t, narrowed[0]["outputPorts"])
}
