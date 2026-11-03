package server

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/datasets"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/store"
)

// WorkflowsCreateWithContent creates a workflow whose first version is the given content.
func (s *Server) WorkflowsCreateWithContent(ctx context.Context, req api.WorkflowsCreateWithContentRequestObject) (api.WorkflowsCreateWithContentResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	content, err := json.Marshal(req.Body.Content)
	if err != nil {
		return nil, badRequest("invalid content")
	}
	parsed, err := ParseContent(content)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	if err := parsed.Validate(); err != nil {
		return nil, badRequest("%v", err)
	}
	normalized := mustJSON(parsed)
	t, r, err := createKind(ctx, s, workflowKind, createArgs[api.WorkflowSpec]{Name: req.Body.Name, Description: req.Body.Description, Project: req.Body.Project,
		Origin: req.Body.Origin, Content: normalized})
	if err != nil {
		return nil, err
	}
	v, err := s.store.GetVersion(ctx, r.RID, 0)
	if err != nil {
		return nil, err
	}
	return api.WorkflowsCreateWithContent200JSONResponse(api.WorkflowWithVersion{Workflow: t, Version: toVersion(v, r.Kind)}), nil
}

// WorkflowsContent returns a version's content.
func (s *Server) WorkflowsContent(ctx context.Context, req api.WorkflowsContentRequestObject) (api.WorkflowsContentResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "workflow", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	var vno int32
	if req.Params.Vno != nil {
		vno = *req.Params.Vno
	}
	v, err := s.store.GetVersion(ctx, r.RID, vno)
	if err != nil {
		if store.IsNotFound(err) {
			return nil, notFound("version")
		}
		return nil, err
	}
	return api.WorkflowsContent200JSONResponse(toVersion(v, r.Kind)), nil
}

// WorkflowsEdit applies a JSON Patch over the head content, or full content, as a new version,
// after structural validation. A patch is guarded by the head it was computed from.
func (s *Server) WorkflowsEdit(ctx context.Context, req api.WorkflowsEditRequestObject) (api.WorkflowsEditResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "workflow", authz.ActionWrite)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	edit := *req.Body
	var preview json.RawMessage
	switch {
	case edit.Patch != nil:
		head, err := s.store.GetVersion(ctx, r.RID, 0)
		if err != nil {
			return nil, badRequest("the workflow has no version to patch")
		}
		ops := make([]any, 0, len(*edit.Patch))
		for _, op := range *edit.Patch {
			var m map[string]any
			_ = json.Unmarshal(mustJSON(op), &m)
			ops = append(ops, m)
		}
		if preview, err = applyPatch(head.Content, ops); err != nil {
			return nil, err
		}
		if edit.ExpectedHead == nil {
			h := head.Vno
			edit.ExpectedHead = &h
		}
	case edit.Content != nil:
		preview = mustJSON(edit.Content)
	default:
		return nil, badRequest("patch or content is required")
	}
	parsed, err := ParseContent(preview)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	if err := parsed.Validate(); err != nil {
		return nil, badRequest("%v", err)
	}
	var normalized any
	_ = json.Unmarshal(mustJSON(parsed), &normalized)
	v, err := s.newVersion(ctx, caller, r, api.CreateVersion{Content: normalized, ExpectedHead: edit.ExpectedHead, Message: edit.Message})
	if err != nil {
		return nil, err
	}
	return api.WorkflowsEdit200JSONResponse(toVersion(v, r.Kind)), nil
}

// WorkflowsValidate compiles a version or draft on a unit.
func (s *Server) WorkflowsValidate(ctx context.Context, req api.WorkflowsValidateRequestObject) (api.WorkflowsValidateResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "workflow", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	var spec api.WorkflowSpec
	_ = json.Unmarshal(r.Spec, &spec)
	var raw json.RawMessage
	if req.Body != nil && req.Body.Content != nil {
		raw, _ = json.Marshal(req.Body.Content)
	} else {
		var vno int32
		if req.Body != nil && req.Body.Vno != nil {
			vno = *req.Body.Vno
		}
		v, err := s.store.GetVersion(ctx, r.RID, vno)
		if err != nil {
			return nil, notFound("version")
		}
		raw = v.Content
	}
	content, err := ParseContent(raw)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	if err := content.Validate(); err != nil {
		// Structural problems are reported like compile errors so agents see one shape.
		return api.WorkflowsValidate200JSONResponse(api.CompileResult{Ok: false,
			OperatorErrors:        map[string]any{"_workflow": map[string]any{"message": err.Error()}},
			OperatorOutputSchemas: map[string]map[string]*[]api.Attribute{}}), nil
	}
	unitRes, err := s.pickUnit(ctx, caller, req.Params.ComputingUnit, spec)
	if err != nil {
		return nil, err
	}
	unit, err := s.unitFor(ctx, unitRes)
	if err != nil {
		return nil, err
	}
	resolved, _, err := s.resolveInputs(ctx, caller, content, nil)
	if err != nil {
		return nil, err
	}
	_ = resolved
	result, err := unit.Compile(ctx, content.ToLogicalPlan())
	if err != nil {
		return nil, err
	}
	return api.WorkflowsValidate200JSONResponse(engineCompileToAPI(result)), nil
}

func engineCompileToAPI(c *engine.CompileResult) api.CompileResult {
	out := api.CompileResult{Ok: c.Ok, OperatorErrors: map[string]any{}, OperatorOutputSchemas: map[string]map[string]*[]api.Attribute{}, PhysicalPlan: c.PhysicalPlan}
	for k, v := range c.OperatorErrors {
		out.OperatorErrors[k] = v
	}
	for op, ports := range c.OperatorOutputSchemas {
		m := map[string]*[]api.Attribute{}
		for port, attrs := range ports {
			if attrs == nil {
				m[port] = nil
				continue
			}
			list := make([]api.Attribute, 0, len(*attrs))
			for _, a := range *attrs {
				list = append(list, api.Attribute{AttributeName: a.AttributeName, AttributeType: a.AttributeType})
			}
			m[port] = &list
		}
		out.OperatorOutputSchemas[op] = m
	}
	return out
}

// resolvedInput is a dataset file a run reads.
type resolvedInput struct {
	Opid string
	Port string
	Ref  DatasetRef
	RID  uuid.UUID
	Vno  int32
	URL  string
	Size int64
}

// resolveInputs rewrites dataset:// properties into presigned URLs and returns the pinned
// inputs. The content is modified in place.
func (s *Server) resolveInputs(ctx context.Context, caller *authn.Caller, c *WorkflowContent, eid *uuid.UUID) ([]resolvedInput, []engine.ResolvedInput, error) {
	var inputs []resolvedInput
	var forEngine []engine.ResolvedInput
	for i := range c.Operators {
		op := &c.Operators[i]
		refs := FindDatasetRefs(op.OperatorProperties)
		for path, ref := range refs {
			ds, err := s.loadResource(ctx, caller, ref.RID, "dataset", authz.ActionRead)
			if err != nil {
				return nil, nil, err
			}
			vno := ref.Vno
			if vno <= 0 {
				vno = ds.HeadVno
			}
			if vno <= 0 {
				return nil, nil, badRequest("dataset %s has no committed version", ds.Name)
			}
			v, err := s.store.GetVersion(ctx, ds.RID, vno)
			if err != nil {
				return nil, nil, badRequest("dataset %s has no version %d", ds.Name, vno)
			}
			var manifest api.DatasetManifest
			_ = json.Unmarshal(v.Content, &manifest)
			var size int64
			found := false
			for _, f := range manifest.Files {
				if f.Path == ref.Path {
					found, size = true, f.Size
					break
				}
			}
			if !found {
				return nil, nil, badRequest("dataset %s version %d has no file %q", ds.Name, vno, ref.Path)
			}
			url, _, err := s.files.Presign(ctx, datasets.VersionKey(ds.RID.String(), vno, ref.Path))
			if err != nil {
				return nil, nil, unavailable("presign", err)
			}
			SetProperty(op.OperatorProperties, path, url)
			port := "output-0"
			if len(op.OutputPorts) > 0 {
				port = op.OutputPorts[0].PortID
			}
			inputs = append(inputs, resolvedInput{Opid: op.OperatorID, Port: port, Ref: ref, RID: ds.RID, Vno: vno, URL: url, Size: size})
			forEngine = append(forEngine, engine.ResolvedInput{Dataset: ds.RID.String(), Vno: vno, Path: ref.Path, Url: url, SizeBytes: &size})
		}
	}
	return inputs, forEngine, nil
}

// WorkflowsRun starts an execution of a workflow version on a unit.
func (s *Server) WorkflowsRun(ctx context.Context, req api.WorkflowsRunRequestObject) (api.WorkflowsRunResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "workflow", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	body := api.RunRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	var spec api.WorkflowSpec
	_ = json.Unmarshal(r.Spec, &spec)
	var vno int32
	if body.Vno != nil {
		vno = *body.Vno
	}
	v, err := s.store.GetVersion(ctx, r.RID, vno)
	if err != nil {
		return nil, notFound("workflow version")
	}
	content, err := ParseContent(v.Content)
	if err != nil {
		return nil, badRequest("%v", err)
	}
	if err := content.Validate(); err != nil {
		return nil, badRequest("%v", err)
	}
	unitRes, err := s.pickUnit(ctx, caller, body.ComputingUnit, spec)
	if err != nil {
		return nil, err
	}
	unit, err := s.unitFor(ctx, unitRes)
	if err != nil {
		return nil, err
	}
	// Environment: explicit, or the workflow's default.
	var envReq *engine.EnvironmentRequest
	var envRID *uuid.UUID
	var envVno *int32
	envRef := body.Environment
	if envRef == nil {
		envRef = spec.DefaultEnvironment
	}
	if envRef != nil && *envRef != "" {
		envRes, err := s.loadResource(ctx, caller, *envRef, "environment", authz.ActionRead)
		if err != nil {
			return nil, err
		}
		var envSpec api.EnvironmentSpec
		_ = json.Unmarshal(envRes.Spec, &envSpec)
		envRID, envVno = &envRes.RID, &envRes.HeadVno
		envReq = &engine.EnvironmentRequest{Rid: envRes.RID.String(), Vno: envRes.HeadVno}
		if envSpec.Python != nil {
			envReq.Python = &struct {
				Packages []string `json:"packages"`
				Version  *string  `json:"version,omitempty"`
			}{Packages: envSpec.Python.Packages, Version: envSpec.Python.Version}
		}
	}
	inputs, forEngine, err := s.resolveInputs(ctx, caller, content, nil)
	if err != nil {
		return nil, err
	}
	origin, err := originFor(caller, body.Origin)
	if err != nil {
		return nil, err
	}
	in := store.NewExecution{Name: body.Name, WorkflowRID: r.RID, WorkflowVno: v.Vno, EnvRID: envRID, EnvVno: envVno, CuRID: unitRes.RID,
		ActorPID: caller.Actor(), OnBehalfOfPID: onBehalfOf(caller), Origin: origin}
	if body.Parameters != nil {
		in.Parameters = mustJSON(*body.Parameters)
	}
	seen := map[string]bool{}
	for _, i := range inputs {
		key := i.RID.String() + "@" + fmt.Sprint(i.Vno)
		if !seen[key] {
			seen[key] = true
			in.Inputs = append(in.Inputs, store.VersionRef{RID: i.RID, Vno: i.Vno})
		}
	}
	ex, err := s.store.CreateExecution(ctx, in)
	if err != nil {
		return nil, err
	}
	for _, i := range inputs {
		_ = s.store.AddPortInput(ctx, store.PortInput{EID: ex.EID, Opid: i.Opid, Port: i.Port, RID: i.RID, Vno: i.Vno, Path: i.Ref.Path})
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, unavailable("service token", err)
	}
	startReq := engine.ExecutionStartRequest{
		Eid:  ex.EID.String(),
		Name: body.Name,
		Workflow: struct {
			Rid string `json:"rid"`
			Vno int32  `json:"vno"`
		}{Rid: r.RID.String(), Vno: v.Vno},
		LogicalPlan: content.ToLogicalPlan(),
		Environment: envReq,
		ResultStore: &engine.ResultStore{CatalogUri: s.cfg.IcebergCatalogURI, Warehouse: s.cfg.IcebergWarehouse, Namespace: "e_" + sanitizeNamespace(ex.EID.String())},
		Reporting:   engine.Reporting{LineageUrl: s.cfg.LineageCallbackURL, Token: token},
		Actor:       caller.Actor().String(),
	}
	if len(forEngine) > 0 {
		startReq.Inputs = &forEngine
	}
	if ob := onBehalfOf(caller); ob != nil {
		str := ob.String()
		startReq.OnBehalfOf = &str
	}
	if body.Parameters != nil {
		startReq.Parameters = body.Parameters
	}
	if _, err := unit.Start(ctx, startReq); err != nil {
		errBody := mustJSON(map[string]any{"message": err.Error()})
		if _, uerr := s.store.SetExecutionStatus(ctx, ex.EID, "failed", errBody); uerr != nil {
			s.log.Warn("mark failed", "err", uerr)
		}
		return nil, unavailable("start execution on unit "+unitRes.Name, err)
	}
	if body.WaitSeconds != nil && *body.WaitSeconds > 0 {
		s.waitForExecution(ctx, ex.EID, time.Duration(*body.WaitSeconds)*time.Second)
	}
	return api.WorkflowsRun200JSONResponse(s.executionView(ctx, ex.EID)), nil
}

func sanitizeNamespace(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			out = append(out, c)
		} else if c == '-' {
			out = append(out, '_')
		}
	}
	return string(out)
}

// waitForExecution polls until the execution is terminal or the deadline passes.
func (s *Server) waitForExecution(ctx context.Context, eid uuid.UUID, max time.Duration) {
	if max > 10*time.Minute {
		max = 10 * time.Minute
	}
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		ex, err := s.store.GetExecution(ctx, eid)
		if err != nil {
			return
		}
		switch ex.Status {
		case "completed", "failed", "cancelled":
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// executionView assembles the API execution with inputs and results.
func (s *Server) executionView(ctx context.Context, eid uuid.UUID) api.Execution {
	ex, err := s.store.GetExecution(ctx, eid)
	if err != nil {
		return api.Execution{Eid: eid.String()}
	}
	inputs, _ := s.store.ListExecutionInputs(ctx, eid)
	results, _ := s.store.ListPortResults(ctx, eid)
	return toExecution(ex, inputs, results)
}

// WorkflowsListExecutions lists a workflow's executions.
func (s *Server) WorkflowsListExecutions(ctx context.Context, req api.WorkflowsListExecutionsRequestObject) (api.WorkflowsListExecutionsResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.loadResource(ctx, caller, req.Rid, "workflow", authz.ActionRead)
	if err != nil {
		return nil, err
	}
	limit, offset := limitOf(req.Params.Limit, 50), decodeCursor(req.Params.Cursor)
	exs, err := s.store.ListExecutions(ctx, &r.RID, nil, limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]api.Execution, 0, len(exs))
	for i := range exs {
		items = append(items, s.executionView(ctx, exs[i].EID))
	}
	return api.WorkflowsListExecutions200JSONResponse(api.ExecutionPage{Items: items, NextCursor: encodeCursor(offset, len(exs), limit)}), nil
}
