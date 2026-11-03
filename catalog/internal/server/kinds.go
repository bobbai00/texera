package server

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

type callerT = authn.Caller

func onBehalfOf(c *callerT) *uuid.UUID {
	if c.Agent == nil {
		return nil
	}
	pid := c.Principal.PID
	return &pid
}

// kindDef describes how a kind maps the envelope onto its typed model.
type kindDef[T any, Spec any, Status any] struct {
	kind string
	// versionedBySpec kinds record every spec as a version (templates, environments, ...).
	versionedBySpec bool
	// defaultContent is the first version's content for kinds whose versions hold content.
	defaultContent json.RawMessage
	build          func(meta api.ResourceMetadata, spec Spec, status *Status) T
}

func convertKind[T, Spec, Status any](k kindDef[T, Spec, Status], r *store.Resource) (T, error) {
	var spec Spec
	var zero T
	if len(r.Spec) > 0 {
		if err := json.Unmarshal(r.Spec, &spec); err != nil {
			return zero, err
		}
	}
	var status *Status
	if len(r.Status) > 0 && string(r.Status) != "null" {
		var st Status
		if err := json.Unmarshal(r.Status, &st); err == nil {
			status = &st
		}
	}
	return k.build(metadataOf(r), spec, status), nil
}

func listKind[T, Spec, Status any](ctx context.Context, s *Server, k kindDef[T, Spec, Status], project *api.Rid, q *string, limit *int32, cursor *string) ([]T, *string, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, nil, err
	}
	f := store.ResourceFilter{Kind: k.kind, Limit: limitOf(limit, 50), Offset: decodeCursor(cursor), ReadableBy: &caller.Principal.PID}
	if q != nil {
		f.Query = *q
	}
	if project != nil {
		rid, err := parseRid(*project)
		if err != nil {
			return nil, nil, err
		}
		f.ParentRID = &rid
	}
	rs, err := s.store.SearchResources(ctx, f)
	if err != nil {
		return nil, nil, err
	}
	items := make([]T, 0, len(rs))
	for i := range rs {
		t, err := convertKind(k, &rs[i])
		if err != nil {
			return nil, nil, err
		}
		items = append(items, t)
	}
	return items, encodeCursor(f.Offset, len(rs), f.Limit), nil
}

func readKind[T, Spec, Status any](ctx context.Context, s *Server, k kindDef[T, Spec, Status], rid string) (T, error) {
	var zero T
	caller, err := callerOf(ctx)
	if err != nil {
		return zero, err
	}
	r, err := s.loadResource(ctx, caller, rid, k.kind, authz.ActionRead)
	if err != nil {
		return zero, err
	}
	return convertKind(k, r)
}

type createArgs[Spec any] struct {
	Name        string
	Description *string
	Project     *api.Rid
	Visibility  *api.Visibility
	Labels      *map[string]string
	Spec        Spec
	Origin      *api.Origin
	// Content overrides the kind's default first-version content.
	Content json.RawMessage
}

func createKind[T, Spec, Status any](ctx context.Context, s *Server, k kindDef[T, Spec, Status], a createArgs[Spec]) (T, *store.Resource, error) {
	var zero T
	caller, err := callerOf(ctx)
	if err != nil {
		return zero, nil, err
	}
	if a.Name == "" {
		return zero, nil, badRequest("name is required")
	}
	parent, err := s.resolveProject(ctx, caller, a.Project)
	if err != nil {
		return zero, nil, err
	}
	origin, err := originFor(caller, a.Origin)
	if err != nil {
		return zero, nil, err
	}
	in := store.NewResource{
		Kind: k.kind, Name: a.Name, Description: a.Description, ParentRID: &parent,
		OwnerPID: caller.Principal.PID, CreatedByPID: caller.Actor(), OnBehalfOfPID: onBehalfOf(caller), Origin: origin,
		Spec: mustJSON(a.Spec),
	}
	if a.Visibility != nil {
		in.Visibility = string(*a.Visibility)
	}
	if a.Labels != nil {
		in.Labels = *a.Labels
	}
	switch {
	case a.Content != nil:
		in.Content = a.Content
	case k.versionedBySpec:
		in.Content = in.Spec
	case k.defaultContent != nil:
		in.Content = k.defaultContent
	}
	r, _, err := s.store.CreateResource(ctx, in)
	if err != nil {
		return zero, nil, err
	}
	s.drainer.Kick()
	t, err := convertKind(k, r)
	return t, r, err
}

func updateSpecKind[T, Spec, Status any](ctx context.Context, s *Server, k kindDef[T, Spec, Status], rid string, spec Spec) (T, error) {
	var zero T
	caller, err := callerOf(ctx)
	if err != nil {
		return zero, err
	}
	r, err := s.loadResource(ctx, caller, rid, k.kind, authz.ActionWrite)
	if err != nil {
		return zero, err
	}
	raw := mustJSON(spec)
	out, err := s.store.UpdateSpec(ctx, r.RID, raw)
	if err != nil {
		return zero, err
	}
	if k.versionedBySpec {
		if _, err := s.store.CreateVersion(ctx, store.NewVersion{RID: r.RID, Content: raw, CreatedByPID: caller.Actor(), OnBehalfOfPID: onBehalfOf(caller)}); err != nil {
			return zero, err
		}
		out, err = s.store.GetResource(ctx, r.RID)
		if err != nil {
			return zero, err
		}
	}
	return convertKind(k, out)
}

// ---- kind definitions ----

var projectKind = kindDef[api.Project, api.ProjectSpec, api.ProjectStatus]{kind: "project",
	build: func(m api.ResourceMetadata, sp api.ProjectSpec, st *api.ProjectStatus) api.Project {
		return api.Project{ApiVersion: api.ProjectApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindProject, Metadata: m, Spec: sp, Status: st}
	}}

var workflowKind = kindDef[api.Workflow, api.WorkflowSpec, api.WorkflowStatus]{kind: "workflow",
	defaultContent: json.RawMessage(`{"operators":[],"links":[]}`),
	build: func(m api.ResourceMetadata, sp api.WorkflowSpec, st *api.WorkflowStatus) api.Workflow {
		return api.Workflow{ApiVersion: api.WorkflowApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindWorkflow, Metadata: m, Spec: sp, Status: st}
	}}

var datasetKind = kindDef[api.Dataset, api.DatasetSpec, api.DatasetStatus]{kind: "dataset",
	build: func(m api.ResourceMetadata, sp api.DatasetSpec, st *api.DatasetStatus) api.Dataset {
		return api.Dataset{ApiVersion: api.DatasetApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindDataset, Metadata: m, Spec: sp, Status: st}
	}}

var environmentKind = kindDef[api.Environment, api.EnvironmentSpec, api.EnvironmentStatus]{kind: "environment", versionedBySpec: true,
	build: func(m api.ResourceMetadata, sp api.EnvironmentSpec, st *api.EnvironmentStatus) api.Environment {
		return api.Environment{ApiVersion: api.EnvironmentApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindEnvironment, Metadata: m, Spec: sp, Status: st}
	}}

var computingUnitKind = kindDef[api.ComputingUnit, api.ComputingUnitSpec, api.ComputingUnitStatus]{kind: "computing_unit",
	build: func(m api.ResourceMetadata, sp api.ComputingUnitSpec, st *api.ComputingUnitStatus) api.ComputingUnit {
		return api.ComputingUnit{ApiVersion: api.ComputingUnitApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindComputingUnit, Metadata: m, Spec: sp, Status: st}
	}}

var agentTemplateKind = kindDef[api.AgentTemplate, api.AgentTemplateSpec, api.AgentTemplateStatus]{kind: "agent_template", versionedBySpec: true,
	build: func(m api.ResourceMetadata, sp api.AgentTemplateSpec, st *api.AgentTemplateStatus) api.AgentTemplate {
		return api.AgentTemplate{ApiVersion: api.AgentTemplateApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindAgentTemplate, Metadata: m, Spec: sp, Status: st}
	}}

var mcpServerKind = kindDef[api.McpServer, api.McpServerSpec, api.McpServerStatus]{kind: "mcp_server", versionedBySpec: true,
	build: func(m api.ResourceMetadata, sp api.McpServerSpec, st *api.McpServerStatus) api.McpServer {
		return api.McpServer{ApiVersion: api.McpServerApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindMcpServer, Metadata: m, Spec: sp, Status: st}
	}}

var skillKind = kindDef[api.Skill, api.SkillSpec, api.SkillStatus]{kind: "skill", versionedBySpec: true,
	build: func(m api.ResourceMetadata, sp api.SkillSpec, st *api.SkillStatus) api.Skill {
		return api.Skill{ApiVersion: api.SkillApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindSkill, Metadata: m, Spec: sp, Status: st}
	}}

var conversationKind = kindDef[api.Conversation, api.ConversationSpec, api.ConversationStatus]{kind: "conversation",
	build: func(m api.ResourceMetadata, sp api.ConversationSpec, st *api.ConversationStatus) api.Conversation {
		return api.Conversation{ApiVersion: api.ConversationApiVersionCatalogTexeraApacheOrgv1, Kind: api.ResourceKindConversation, Metadata: m, Spec: sp, Status: st}
	}}

// ---- Projects ----

func (s *Server) ProjectsList(ctx context.Context, req api.ProjectsListRequestObject) (api.ProjectsListResponseObject, error) {
	items, next, err := listKind(ctx, s, projectKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.ProjectsList200JSONResponse(api.ProjectPage{Items: items, NextCursor: next}), nil
}

func (s *Server) ProjectsCreate(ctx context.Context, req api.ProjectsCreateRequestObject) (api.ProjectsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, _, err := createKind(ctx, s, projectKind, createArgs[api.ProjectSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.ProjectsCreate200JSONResponse(t), nil
}

func (s *Server) ProjectsRead(ctx context.Context, req api.ProjectsReadRequestObject) (api.ProjectsReadResponseObject, error) {
	t, err := readKind(ctx, s, projectKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.ProjectsRead200JSONResponse(t), nil
}

func (s *Server) ProjectsUpdateSpec(ctx context.Context, req api.ProjectsUpdateSpecRequestObject) (api.ProjectsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, projectKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.ProjectsUpdateSpec200JSONResponse(t), nil
}

// ---- Workflows (generic part; content routes live in workflows.go) ----

func (s *Server) WorkflowsList(ctx context.Context, req api.WorkflowsListRequestObject) (api.WorkflowsListResponseObject, error) {
	items, next, err := listKind(ctx, s, workflowKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.WorkflowsList200JSONResponse(api.WorkflowPage{Items: items, NextCursor: next}), nil
}

func (s *Server) WorkflowsCreate(ctx context.Context, req api.WorkflowsCreateRequestObject) (api.WorkflowsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, _, err := createKind(ctx, s, workflowKind, createArgs[api.WorkflowSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.WorkflowsCreate200JSONResponse(t), nil
}

func (s *Server) WorkflowsRead(ctx context.Context, req api.WorkflowsReadRequestObject) (api.WorkflowsReadResponseObject, error) {
	t, err := readKind(ctx, s, workflowKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.WorkflowsRead200JSONResponse(t), nil
}

func (s *Server) WorkflowsUpdateSpec(ctx context.Context, req api.WorkflowsUpdateSpecRequestObject) (api.WorkflowsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, workflowKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.WorkflowsUpdateSpec200JSONResponse(t), nil
}

// ---- Datasets (generic part; files live in datasets.go) ----

func (s *Server) DatasetsList(ctx context.Context, req api.DatasetsListRequestObject) (api.DatasetsListResponseObject, error) {
	items, next, err := listKind(ctx, s, datasetKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.DatasetsList200JSONResponse(api.DatasetPage{Items: items, NextCursor: next}), nil
}

func (s *Server) DatasetsCreate(ctx context.Context, req api.DatasetsCreateRequestObject) (api.DatasetsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, _, err := createKind(ctx, s, datasetKind, createArgs[api.DatasetSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.DatasetsCreate200JSONResponse(t), nil
}

func (s *Server) DatasetsRead(ctx context.Context, req api.DatasetsReadRequestObject) (api.DatasetsReadResponseObject, error) {
	t, err := readKind(ctx, s, datasetKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.DatasetsRead200JSONResponse(t), nil
}

func (s *Server) DatasetsUpdateSpec(ctx context.Context, req api.DatasetsUpdateSpecRequestObject) (api.DatasetsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, datasetKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.DatasetsUpdateSpec200JSONResponse(t), nil
}

// ---- Environments ----

func (s *Server) EnvironmentsList(ctx context.Context, req api.EnvironmentsListRequestObject) (api.EnvironmentsListResponseObject, error) {
	items, next, err := listKind(ctx, s, environmentKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.EnvironmentsList200JSONResponse(api.EnvironmentPage{Items: items, NextCursor: next}), nil
}

func (s *Server) EnvironmentsCreate(ctx context.Context, req api.EnvironmentsCreateRequestObject) (api.EnvironmentsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, _, err := createKind(ctx, s, environmentKind, createArgs[api.EnvironmentSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.EnvironmentsCreate200JSONResponse(t), nil
}

func (s *Server) EnvironmentsRead(ctx context.Context, req api.EnvironmentsReadRequestObject) (api.EnvironmentsReadResponseObject, error) {
	t, err := readKind(ctx, s, environmentKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.EnvironmentsRead200JSONResponse(t), nil
}

func (s *Server) EnvironmentsUpdateSpec(ctx context.Context, req api.EnvironmentsUpdateSpecRequestObject) (api.EnvironmentsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, environmentKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.EnvironmentsUpdateSpec200JSONResponse(t), nil
}

// ---- Agent templates ----

func (s *Server) AgentTemplatesList(ctx context.Context, req api.AgentTemplatesListRequestObject) (api.AgentTemplatesListResponseObject, error) {
	items, next, err := listKind(ctx, s, agentTemplateKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.AgentTemplatesList200JSONResponse(api.AgentTemplatePage{Items: items, NextCursor: next}), nil
}

func (s *Server) AgentTemplatesCreate(ctx context.Context, req api.AgentTemplatesCreateRequestObject) (api.AgentTemplatesCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	if req.Body.Spec.Card.Name == "" {
		return nil, badRequest("spec.card.name is required")
	}
	t, _, err := createKind(ctx, s, agentTemplateKind, createArgs[api.AgentTemplateSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.AgentTemplatesCreate200JSONResponse(t), nil
}

func (s *Server) AgentTemplatesRead(ctx context.Context, req api.AgentTemplatesReadRequestObject) (api.AgentTemplatesReadResponseObject, error) {
	t, err := readKind(ctx, s, agentTemplateKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.AgentTemplatesRead200JSONResponse(t), nil
}

func (s *Server) AgentTemplatesUpdateSpec(ctx context.Context, req api.AgentTemplatesUpdateSpecRequestObject) (api.AgentTemplatesUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, agentTemplateKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.AgentTemplatesUpdateSpec200JSONResponse(t), nil
}

// ---- MCP servers ----

func (s *Server) McpServersList(ctx context.Context, req api.McpServersListRequestObject) (api.McpServersListResponseObject, error) {
	items, next, err := listKind(ctx, s, mcpServerKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.McpServersList200JSONResponse(api.McpServerPage{Items: items, NextCursor: next}), nil
}

func (s *Server) McpServersCreate(ctx context.Context, req api.McpServersCreateRequestObject) (api.McpServersCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	if req.Body.Spec.Transport == api.StreamableHttp && (req.Body.Spec.Url == nil || *req.Body.Spec.Url == "") {
		return nil, badRequest("spec.url is required for streamable_http servers")
	}
	t, _, err := createKind(ctx, s, mcpServerKind, createArgs[api.McpServerSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.McpServersCreate200JSONResponse(t), nil
}

func (s *Server) McpServersRead(ctx context.Context, req api.McpServersReadRequestObject) (api.McpServersReadResponseObject, error) {
	t, err := readKind(ctx, s, mcpServerKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.McpServersRead200JSONResponse(t), nil
}

func (s *Server) McpServersUpdateSpec(ctx context.Context, req api.McpServersUpdateSpecRequestObject) (api.McpServersUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, mcpServerKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.McpServersUpdateSpec200JSONResponse(t), nil
}

// ---- Skills ----

func (s *Server) SkillsList(ctx context.Context, req api.SkillsListRequestObject) (api.SkillsListResponseObject, error) {
	items, next, err := listKind(ctx, s, skillKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.SkillsList200JSONResponse(api.SkillPage{Items: items, NextCursor: next}), nil
}

func (s *Server) SkillsCreate(ctx context.Context, req api.SkillsCreateRequestObject) (api.SkillsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, _, err := createKind(ctx, s, skillKind, createArgs[api.SkillSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.SkillsCreate200JSONResponse(t), nil
}

func (s *Server) SkillsRead(ctx context.Context, req api.SkillsReadRequestObject) (api.SkillsReadResponseObject, error) {
	t, err := readKind(ctx, s, skillKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.SkillsRead200JSONResponse(t), nil
}

func (s *Server) SkillsUpdateSpec(ctx context.Context, req api.SkillsUpdateSpecRequestObject) (api.SkillsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, skillKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.SkillsUpdateSpec200JSONResponse(t), nil
}

// ---- Conversations ----

func (s *Server) ConversationsList(ctx context.Context, req api.ConversationsListRequestObject) (api.ConversationsListResponseObject, error) {
	items, next, err := listKind(ctx, s, conversationKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.ConversationsList200JSONResponse(api.ConversationPage{Items: items, NextCursor: next}), nil
}

func (s *Server) ConversationsCreate(ctx context.Context, req api.ConversationsCreateRequestObject) (api.ConversationsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	tpl, err := s.loadResource(ctx, caller, req.Body.Spec.Template.Rid, "agent_template", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	spec := req.Body.Spec
	if spec.Template.Vno <= 0 {
		spec.Template.Vno = tpl.HeadVno
	}
	t, _, err := createKind(ctx, s, conversationKind, createArgs[api.ConversationSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.ConversationsCreate200JSONResponse(t), nil
}

func (s *Server) ConversationsRead(ctx context.Context, req api.ConversationsReadRequestObject) (api.ConversationsReadResponseObject, error) {
	t, err := readKind(ctx, s, conversationKind, req.Rid)
	if err != nil {
		return nil, err
	}
	return api.ConversationsRead200JSONResponse(t), nil
}

func (s *Server) ConversationsUpdateSpec(ctx context.Context, req api.ConversationsUpdateSpecRequestObject) (api.ConversationsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, conversationKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.ConversationsUpdateSpec200JSONResponse(t), nil
}

func (s *Server) ConversationsMessages(ctx context.Context, req api.ConversationsMessagesRequestObject) (api.ConversationsMessagesResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "conversation", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	var after int64
	if req.Params.After != nil {
		after = *req.Params.After
	}
	ms, err := s.store.ListMessages(ctx, r.RID, after, limitOf(req.Params.Limit, 200))
	if err != nil {
		return nil, err
	}
	out := make([]api.Message, 0, len(ms))
	for i := range ms {
		out = append(out, toMessage(&ms[i]))
	}
	return api.ConversationsMessages200JSONResponse(out), nil
}

func (s *Server) ConversationsPost(ctx context.Context, req api.ConversationsPostRequestObject) (api.ConversationsPostResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "conversation", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	// A user message is the person's own words even when an agent runtime relays it; everything
	// else is authored by the acting principal (the agent, on behalf of the person).
	author, onBehalf := caller.Actor(), onBehalfOf(caller)
	if req.Body.Role == api.PostMessageRoleUser {
		author, onBehalf = caller.Principal.PID, nil
	}
	m, err := s.store.AppendMessage(ctx, r.RID, string(req.Body.Role), author, onBehalf, mustJSON(req.Body.Parts))
	if err != nil {
		return nil, err
	}
	return api.ConversationsPost200JSONResponse(toMessage(m)), nil
}

func (s *Server) ConversationsResources(ctx context.Context, req api.ConversationsResourcesRequestObject) (api.ConversationsResourcesResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "conversation", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	rs, err := s.store.SearchResources(ctx, store.ResourceFilter{Origin: &r.RID, Limit: 200, ReadableBy: &caller.Principal.PID})
	if err != nil {
		return nil, err
	}
	out := make([]api.Resource, 0, len(rs))
	for i := range rs {
		out = append(out, toResource(&rs[i]))
	}
	return api.ConversationsResources200JSONResponse(out), nil
}

// ---- Computing units ----

func (s *Server) ComputingUnitsList(ctx context.Context, req api.ComputingUnitsListRequestObject) (api.ComputingUnitsListResponseObject, error) {
	items, next, err := listKind(ctx, s, computingUnitKind, req.Params.Project, req.Params.Q, req.Params.Limit, req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	return api.ComputingUnitsList200JSONResponse(api.ComputingUnitPage{Items: items, NextCursor: next}), nil
}

func (s *Server) ComputingUnitsCreate(ctx context.Context, req api.ComputingUnitsCreateRequestObject) (api.ComputingUnitsCreateResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	switch req.Body.Spec.UnitKind {
	case api.Static:
		if req.Body.Spec.Endpoint == nil || *req.Body.Spec.Endpoint == "" {
			return nil, badRequest("spec.endpoint is required for a static unit")
		}
	default:
		// Provider-backed units are the unit operator's job; the catalog records the request
		// and a provider reconciles it. Not implemented in this slice.
		return nil, &Problem{Status: 501, Code: "not_implemented", Message: "only static units can be created in this deployment"}
	}
	t, _, err := createKind(ctx, s, computingUnitKind, createArgs[api.ComputingUnitSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Visibility: req.Body.Visibility, Labels: req.Body.Labels, Spec: req.Body.Spec, Origin: req.Body.Origin})
	if err != nil {
		return nil, err
	}
	return api.ComputingUnitsCreate200JSONResponse(t), nil
}

func (s *Server) ComputingUnitsRead(ctx context.Context, req api.ComputingUnitsReadRequestObject) (api.ComputingUnitsReadResponseObject, error) {
	t, err := readKind(ctx, s, computingUnitKind, req.Rid)
	if err != nil {
		return nil, err
	}
	t.Status = s.unitStatus(ctx, &t)
	return api.ComputingUnitsRead200JSONResponse(t), nil
}

func (s *Server) ComputingUnitsUpdateSpec(ctx context.Context, req api.ComputingUnitsUpdateSpecRequestObject) (api.ComputingUnitsUpdateSpecResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	t, err := updateSpecKind(ctx, s, computingUnitKind, req.Rid, *req.Body)
	if err != nil {
		return nil, err
	}
	return api.ComputingUnitsUpdateSpec200JSONResponse(t), nil
}

func (s *Server) ComputingUnitsAvailable(ctx context.Context, _ api.ComputingUnitsAvailableRequestObject) (api.ComputingUnitsAvailableResponseObject, error) {
	items, _, err := listKind(ctx, s, computingUnitKind, nil, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i].Status = s.unitStatus(ctx, &items[i])
	}
	return api.ComputingUnitsAvailable200JSONResponse(items), nil
}

func (s *Server) ComputingUnitsTerminate(ctx context.Context, req api.ComputingUnitsTerminateRequestObject) (api.ComputingUnitsTerminateResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "computing_unit", authz.ActionDelete)
	if err != nil {
		return nil, err
	}
	phase := api.ComputingUnitStatusPhaseTerminated
	if err := s.store.UpdateStatus(ctx, r.RID, mustJSON(api.ComputingUnitStatus{Phase: phase})); err != nil {
		return nil, err
	}
	r, err = s.store.GetResource(ctx, r.RID)
	if err != nil {
		return nil, err
	}
	t, err := convertKind(computingUnitKind, r)
	if err != nil {
		return nil, err
	}
	return api.ComputingUnitsTerminate200JSONResponse(t), nil
}
