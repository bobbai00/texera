package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// RunInput is what Run needs.
type RunInput struct {
	Vno           int
	ComputingUnit string
	Environment   string
	Parameters    map[string]any
	WaitSeconds   int
	Name          string
}

var (
	workflowKind, _    = kinds.ByName("workflow")
	executionKind, _   = kinds.ByName("execution")
	datasetKind, _     = kinds.ByName("dataset")
	unitKind, _        = kinds.ByName("computing-unit")
	environmentKind, _ = kinds.ByName("environment")
)

// Run starts an execution of a workflow version in three phases. Authorize: the caller may
// execute the workflow and, once the plan is compiled, run on the unit, read every dataset,
// operator and environment it names and use every credential; nothing is written before that
// passes. Compile: the version becomes a plan that is data, the same one a dry run returns.
// Materialize: the execution is stored with its plan, its namespace is opened in the lake,
// the inputs are presigned and the credentials leased into a copy of the plan that goes to the
// engine, and never into the store. With WaitSeconds the call waits for the run to end.
func (s *Service) Run(ctx context.Context, caller *auth.Caller, workflowRID uuid.UUID, in RunInput) (*store.Resource, error) {
	wf, err := s.Get(ctx, caller, &workflowKind, workflowRID)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Execute, wf.RID); err != nil {
		return nil, err
	}
	version, err := s.Store.GetVersion(ctx, wf.RID, in.Vno)
	if err != nil {
		return nil, NotFound(fmt.Sprintf("version %d of %s", in.Vno, wf.Name))
	}
	var spec api.WorkflowSpec
	if err := json.Unmarshal(version.Content, &spec); err != nil {
		return nil, Invalid("the workflow version is not a workflow spec: "+err.Error(), nil)
	}
	if len(spec.Operators) == 0 {
		return nil, Invalid("the workflow has no operators", nil)
	}
	project := s.projectSpec(ctx, wf.ProjectRID)
	settings := s.settingsSpec(ctx)
	unitName := firstNonEmpty(in.ComputingUnit, uriString(spec.DefaultComputingUnit), uriString(project.DefaultComputingUnit), uriString(settings.Defaults.ComputingUnit))
	if unitName == "" {
		return nil, Conflict("no_unit", "no computing unit: name one in the request, the workflow, the project or the settings", nil)
	}
	unit, err := s.unitByURI(ctx, unitName)
	if err != nil {
		return nil, err
	}

	// Compile, then authorize everything the plan names.
	c, err := s.compile(ctx, spec)
	if err != nil {
		return nil, err
	}
	fallback := firstNonEmpty(uriString(spec.DefaultEnvironment), uriString(project.DefaultEnvironment), uriString(settings.Defaults.Environment))
	env, envVno, err := s.resolveEnvironment(ctx, in.Environment, fallback, c.Pins)
	if err != nil {
		return nil, err
	}
	if err := s.authorizePlan(ctx, caller, c, unit, env); err != nil {
		return nil, err
	}
	client, status, err := s.unitClient(ctx, unit)
	if err != nil {
		return nil, err
	}
	if status.Phase != api.ComputingUnitStatusPhaseReady {
		return nil, Conflict("unit_not_ready", fmt.Sprintf("the unit %s is %s", unit.Name, status.Phase), nil)
	}
	unitURI := URI(unit).String()
	running, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "execution", ParentRID: &wf.RID, Fields: map[string]string{"/spec/computingUnit": unitURI, "/status/phase": "running"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(running) > 0 {
		return nil, Conflict("running", fmt.Sprintf("execution %s of this workflow is still running on %s; cancel it or wait", running[0].RID, unit.Name), map[string]any{"execution": running[0].RID.String()})
	}

	// Materialize: the execution with its plan, its namespace, the bound copy, the start.
	name := in.Name
	if name == "" {
		name = fmt.Sprintf("run %s", time.Now().UTC().Format("2006-01-02 15:04:05"))
	}
	rid := uuid.New()
	namespace := executionNamespace(rid)
	plan := c.apiPlan(namespace)
	execSpec := api.ExecutionSpec{Workflow: api.Uri(URI(wf).WithVersion(version.Vno).String()), ComputingUnit: api.Uri(unitURI), Plan: &plan}
	if env != nil {
		e := api.Uri(URI(env).WithVersion(envVno).String())
		execSpec.Environment = &e
	}
	if inputs := c.inputURIs(); len(inputs) > 0 {
		uris := make([]api.Uri, len(inputs))
		for i, u := range inputs {
			uris[i] = api.Uri(u)
		}
		execSpec.Inputs = &uris
	}
	if len(in.Parameters) > 0 {
		execSpec.Parameters = &in.Parameters
	}
	// The ports are known from the plan: their tables exist in the status before the run writes
	// a row, and the unit may only ever report those.
	ports := make([]api.PortSummary, 0, len(c.Outputs))
	tables := make([]engine.OutputTable, 0, len(c.Outputs))
	for _, o := range c.Outputs {
		identifier := namespace + "." + o.Table
		ports = append(ports, api.PortSummary{OperatorID: o.OperatorID, PortID: o.PortID, Table: &identifier})
		tables = append(tables, engine.OutputTable{Opid: o.OperatorID, Port: o.PortID, Table: o.Table})
	}
	exec, _, err := s.Store.CreateResource(ctx, store.NewResource{
		RID: &rid, Kind: "execution", Name: name, ParentRID: &wf.RID, ProjectRID: wf.ProjectRID, OwnerPID: caller.PID(), CreatedByPID: caller.PID(),
		Spec: mustJSON(execSpec), Status: mustJSON(api.ExecutionStatus{Phase: api.ExecutionPhasePending, Ports: &ports}), Origin: caller.Origin,
	})
	if err != nil {
		return nil, wrap(err, "execution")
	}
	s.Relay.Flush(ctx)
	execURI := URI(exec).String()
	fail := func(what string, err error) (*store.Resource, error) {
		s.setPhase(ctx, exec.RID, api.ExecutionPhaseFailed, map[string]any{"message": what + ": " + err.Error()})
		return nil, err
	}
	// The run's tables go into a namespace of their own, which the unit's identity may write.
	subject := ""
	if identity := unitIdentity(unit); identity != nil {
		subject = identity.Subject
	} else {
		s.Log.Warn("the unit has no identity; the lake will take its writes only if it is open", "unit", unit.RID)
	}
	if err := s.Lake.OpenNamespace(ctx, namespace, subject, unit.Name); err != nil {
		return fail("the lake refused the run's namespace", Unavailable("lake", err))
	}
	bound, resolved, err := s.bindInputs(ctx, caller, c)
	if err != nil {
		return fail("binding the inputs", err)
	}
	if err := s.bindSecrets(ctx, caller, &bound, c, execURI); err != nil {
		return fail("leasing the credentials", err)
	}
	if edges := usedEdges(exec, execURI, c); len(edges) > 0 {
		if err := s.Store.AddEdges(ctx, edges); err != nil {
			s.Log.Warn("used edges", "execution", exec.RID, "err", err)
		}
	}
	_, _ = s.Store.MergeStatus(ctx, wf.RID, mustJSON(map[string]any{"lastExecution": exec.RID.String()}))

	req := engine.ExecutionStartRequest{
		Eid: exec.RID.String(),
		Workflow: struct {
			Rid string `json:"rid"`
			Vno int32  `json:"vno"`
		}{Rid: wf.RID.String(), Vno: int32(version.Vno)},
		Name:        &name,
		LogicalPlan: bound,
		ResultStore: &engine.ResultStore{CatalogUri: s.Config.IcebergCatalogURI, Warehouse: s.Config.IcebergWarehouse, Namespace: namespace, Tables: &tables},
		Reporting:   engine.Reporting{LineageUrl: s.Config.LineageCallbackURL},
		Actor:       caller.PID().String(),
	}
	if len(resolved) > 0 {
		req.Inputs = &resolved
	}
	if len(in.Parameters) > 0 {
		params := in.Parameters
		req.Parameters = &params
	}
	if env != nil {
		req.Environment = environmentRequest(ctx, s, env, envVno)
	}
	go s.drive(exec.RID, client, req, env, envVno, unit)

	if in.WaitSeconds > 0 {
		return s.waitForExecution(ctx, exec.RID, time.Duration(in.WaitSeconds)*time.Second)
	}
	r, err := s.Store.GetResource(ctx, exec.RID)
	return r, wrap(err, "execution")
}

func environmentRequest(ctx context.Context, s *Service, env *store.Resource, vno int) *engine.EnvironmentRequest {
	v, err := s.Store.GetVersion(ctx, env.RID, vno)
	if err != nil {
		return nil
	}
	var spec api.EnvironmentSpec
	_ = json.Unmarshal(v.Content, &spec)
	req := &engine.EnvironmentRequest{Rid: env.RID.String(), Vno: int32(vno)}
	if spec.Python != nil {
		req.Python = &struct {
			Packages []string `json:"packages"`
			Version  *string  `json:"version,omitempty"`
		}{Packages: spec.Python.Packages, Version: spec.Python.Version}
	}
	return req
}

// drive builds the environment and starts the run; failures become the execution's status.
func (s *Service) drive(execRID uuid.UUID, client *engine.Unit, req engine.ExecutionStartRequest, env *store.Resource, envVno int, unit *store.Resource) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	fail := func(msg string) {
		s.setPhase(ctx, execRID, api.ExecutionPhaseFailed, map[string]any{"message": msg})
	}
	if req.Environment != nil {
		s.setPhase(ctx, execRID, api.ExecutionPhaseProvisioning, nil)
		if err := s.ensureEnvironment(ctx, client, env, envVno, *req.Environment, unit); err != nil {
			fail("environment: " + err.Error())
			return
		}
	}
	if _, err := client.Start(ctx, req); err != nil {
		fail("start: " + err.Error())
		return
	}
	s.setPhase(ctx, execRID, api.ExecutionPhaseRunning, nil)
}

// ensureEnvironment asks the unit to build the environment version and waits for it.
func (s *Service) ensureEnvironment(ctx context.Context, client *engine.Unit, env *store.Resource, vno int, req engine.EnvironmentRequest, unit *store.Resource) error {
	record := func(state, message string) {
		s.recordBuild(ctx, env, vno, URI(unit).String(), state, message)
	}
	build, err := client.BuildEnvironment(ctx, req)
	if err != nil {
		record("failed", err.Error())
		return err
	}
	record(string(build.Status), deref(build.Message))
	for build.Status == engine.EnvironmentBuildStatusBuilding {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
		build, err = client.EnvironmentStatus(ctx, req.Rid, req.Vno)
		if err != nil {
			record("failed", err.Error())
			return err
		}
		record(string(build.Status), deref(build.Message))
	}
	if build.Status == engine.EnvironmentBuildStatusFailed {
		return fmt.Errorf("build failed: %s", deref(build.Message))
	}
	return nil
}

// recordBuild keeps the environment's builds in its status, one entry per unit and version.
func (s *Service) recordBuild(ctx context.Context, env *store.Resource, vno int, unitURI, state, message string) {
	r, err := s.Store.GetResource(ctx, env.RID)
	if err != nil {
		return
	}
	var status api.EnvironmentStatus
	_ = json.Unmarshal(r.Status, &status)
	builds := []api.EnvironmentBuild{}
	if status.Builds != nil {
		for _, b := range *status.Builds {
			if string(b.ComputingUnit) == unitURI && int(b.Vno) == vno {
				continue
			}
			builds = append(builds, b)
		}
	}
	entry := api.EnvironmentBuild{ComputingUnit: api.Uri(unitURI), Vno: api.Vno(vno), State: api.EnvironmentBuildState(state), At: time.Now().UTC()}
	if message != "" {
		entry.Message = &message
	}
	builds = append(builds, entry)
	status.Builds = &builds
	_, _ = s.Store.UpdateStatus(ctx, env.RID, mustJSON(status))
}

// statusLocks serialize status updates per execution, since the unit's events arrive concurrently.
var statusLocks sync.Map

func lockExecution(rid uuid.UUID) func() {
	mu, _ := statusLocks.LoadOrStore(rid, &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	return mu.(*sync.Mutex).Unlock
}

// updateExecutionStatus applies fn to the execution's status under its lock.
func (s *Service) updateExecutionStatus(ctx context.Context, rid uuid.UUID, fn func(st *api.ExecutionStatus)) error {
	unlock := lockExecution(rid)
	defer unlock()
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil {
		return err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	fn(&st)
	_, err = s.Store.UpdateStatus(ctx, rid, mustJSON(st))
	return err
}

func isTerminal(phase api.ExecutionPhase) bool {
	return phase == api.ExecutionPhaseCompleted || phase == api.ExecutionPhaseFailed || phase == api.ExecutionPhaseCancelled
}

func (s *Service) setPhase(ctx context.Context, rid uuid.UUID, phase api.ExecutionPhase, errBody map[string]any) {
	_ = s.updateExecutionStatus(ctx, rid, func(st *api.ExecutionStatus) {
		if isTerminal(st.Phase) && !isTerminal(phase) {
			return
		}
		st.Phase = phase
		now := time.Now().UTC()
		if phase == api.ExecutionPhaseRunning && st.StartedAt == nil {
			st.StartedAt = &now
		}
		if isTerminal(phase) {
			st.FinishedAt = &now
		}
		if errBody != nil {
			var e any = errBody
			st.Error = &e
		}
	})
}

// waitForExecution polls until the run ends or the time is up.
func (s *Service) waitForExecution(ctx context.Context, rid uuid.UUID, timeout time.Duration) (*store.Resource, error) {
	deadline := time.Now().Add(timeout)
	for {
		r, err := s.Store.GetResource(ctx, rid)
		if err != nil {
			return nil, wrap(err, "execution")
		}
		var st api.ExecutionStatus
		_ = json.Unmarshal(r.Status, &st)
		if isTerminal(st.Phase) || time.Now().After(deadline) {
			return r, nil
		}
		select {
		case <-ctx.Done():
			return r, nil
		case <-time.After(time.Second):
		}
	}
}

// Execution returns one execution of a workflow.
func (s *Service) Execution(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID) (*store.Resource, error) {
	r, err := s.Get(ctx, caller, &executionKind, eid)
	if err != nil {
		return nil, err
	}
	if r.ParentRID == nil || *r.ParentRID != workflowRID {
		return nil, NotFound("execution " + eid.String())
	}
	return r, nil
}

// Cancel stops a run.
func (s *Service) Cancel(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID) (*store.Resource, error) {
	r, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Execute, workflowRID); err != nil {
		return nil, err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	if isTerminal(st.Phase) {
		return r, nil
	}
	if st.Phase == api.ExecutionPhaseRunning {
		if client, err := s.executionUnit(ctx, caller, r); err == nil {
			if _, err := client.Cancel(ctx, eid.String()); err != nil {
				s.Log.Warn("cancel on the unit", "execution", eid, "err", err)
			}
		}
	}
	s.setPhase(ctx, eid, api.ExecutionPhaseCancelled, nil)
	r, err = s.Store.GetResource(ctx, eid)
	return r, wrap(err, "execution")
}

// Pause asks the unit to pause a running execution. The phase turns paused when the unit
// reports it, so the caller watches the execution rather than trusting the answer.
func (s *Service) Pause(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID) (*store.Resource, error) {
	return s.control(ctx, caller, workflowRID, eid, api.ExecutionPhaseRunning, "not_running", "the run is not running", (*engine.Unit).Pause)
}

// Resume continues a paused execution; the phase turns running when the unit reports it.
func (s *Service) Resume(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID) (*store.Resource, error) {
	return s.control(ctx, caller, workflowRID, eid, api.ExecutionPhasePaused, "not_paused", "the run is not paused", (*engine.Unit).Resume)
}

// control forwards a verb to the execution's unit when the run is in the phase the verb needs.
func (s *Service) control(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID, want api.ExecutionPhase, code, msg string,
	do func(*engine.Unit, context.Context, string) (*engine.ExecutionState, error)) (*store.Resource, error) {
	r, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Execute, workflowRID); err != nil {
		return nil, err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	if st.Phase != want {
		return nil, Conflict(code, msg, map[string]any{"phase": st.Phase})
	}
	client, err := s.executionUnit(ctx, caller, r)
	if err != nil {
		return nil, err
	}
	if _, err := do(client, ctx, eid.String()); err != nil {
		return nil, Unavailable("the computing unit", err)
	}
	r, err = s.Store.GetResource(ctx, eid)
	return r, wrap(err, "execution")
}

// DeleteExecution removes a finished run with its tables. A run still going must be cancelled
// first; a run a dataset version derives from stays, as its lineage says.
func (s *Service) DeleteExecution(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID) error {
	r, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Delete, r.RID); err != nil {
		return err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	if !isTerminal(st.Phase) {
		return Conflict("running", "the run is still going; cancel it first", nil)
	}
	deps, err := s.Store.Dependents(ctx, r.RID, 0)
	if err != nil {
		return err
	}
	if len(deps) > 0 {
		var from []string
		for _, d := range deps {
			from = append(from, d.From)
		}
		return Conflict("referenced", fmt.Sprintf("%s is referenced by %d resources", r.Name, len(from)), map[string]any{"dependents": from})
	}
	if err := s.beforeDelete(ctx, r); err != nil {
		return err
	}
	if err := s.Store.DeleteResource(ctx, r.RID); err != nil {
		return wrap(err, "execution")
	}
	s.Relay.Flush(ctx)
	return nil
}

// plannedTable is the table the catalog named for a port, bare, "" when the plan has none.
func plannedTable(exec *store.Resource, operatorID, portID string) string {
	var spec api.ExecutionSpec
	if err := json.Unmarshal(exec.Spec, &spec); err != nil || spec.Plan == nil {
		return ""
	}
	for _, o := range spec.Plan.Outputs {
		if o.OperatorID == operatorID && o.PortID == portID {
			return o.Table
		}
	}
	return ""
}

// executionNamespace is the namespace an execution's tables live in: the catalog makes it in
// the lake before the run and drops it with the execution.
func executionNamespace(rid uuid.UUID) string {
	return "e_" + strings.ReplaceAll(rid.String(), "-", "")
}

// executionUnit returns the client of the unit an execution runs on.
func (s *Service) executionUnit(ctx context.Context, _ *auth.Caller, exec *store.Resource) (*engine.Unit, error) {
	// The caller was allowed to read the execution; the unit is the catalog's to reach.
	var spec api.ExecutionSpec
	_ = json.Unmarshal(exec.Spec, &spec)
	unit, err := s.unitByURI(ctx, string(spec.ComputingUnit))
	if err != nil {
		return nil, err
	}
	client, _, err := s.unitClient(ctx, unit)
	return client, err
}

// Port describes a port of an execution: an output's result, or an input's binding.
func (s *Service) Port(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID, operatorID, portID string) (*api.ExecutionPort, error) {
	r, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, err
	}
	out := &api.ExecutionPort{Uri: api.Uri(URI(r).With("operators", operatorID, "ports", portID).String()), OperatorID: operatorID, PortID: portID}
	if strings.HasPrefix(portID, "input-") {
		out.Direction = api.ExecutionPortDirectionInput
		if bound := s.inputBinding(ctx, r, operatorID, portID); bound != "" {
			b := api.Uri(bound)
			out.BoundTo = &b
		}
		return out, nil
	}
	out.Direction = api.ExecutionPortDirectionOutput
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	if st.Ports != nil {
		for _, p := range *st.Ports {
			if p.OperatorID == operatorID && p.PortID == portID {
				result := p
				out.Result = &result
				return out, nil
			}
		}
	}
	return out, nil
}

// inputBinding finds the upstream port linked to an input port in the execution's workflow version.
func (s *Service) inputBinding(ctx context.Context, exec *store.Resource, operatorID, portID string) string {
	var spec api.ExecutionSpec
	_ = json.Unmarshal(exec.Spec, &spec)
	ref, err := uri.Parse(string(spec.Workflow))
	if err != nil {
		return ""
	}
	wfRID, _ := uuid.Parse(ref.Rid)
	v, err := s.Store.GetVersion(ctx, wfRID, ref.Vno)
	if err != nil {
		return ""
	}
	var wf api.WorkflowSpec
	_ = json.Unmarshal(v.Content, &wf)
	for _, l := range wf.Links {
		if l.Target.OperatorID == operatorID && l.Target.PortID == portID {
			return URI(exec).With("operators", l.Source.OperatorID, "ports", l.Source.PortID).String()
		}
	}
	return ""
}

// Rows reads a page of an output port's result from the unit.
func (s *Service) Rows(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID, operatorID, portID string, offset int64, limit int32) (*engine.RowPage, error) {
	r, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if at := resultsExpired(r); at != nil {
		return nil, Gone("the run's results", *at)
	}
	client, err := s.executionUnit(ctx, caller, r)
	if err != nil {
		return nil, err
	}
	page, err := client.Result(ctx, eid.String(), operatorID, portID, plannedTable(r, operatorID, portID), executionNamespace(eid), offset, limit)
	if err != nil {
		return nil, Unavailable("unit", err)
	}
	return page, nil
}

// unitByURI loads a computing unit without the read check: running on a unit, compiling or
// building on it needs can_run_on, which a `user` grant gives without reading the unit's spec.
// Every caller requires that permission itself.
func (s *Service) unitByURI(ctx context.Context, name string) (*store.Resource, error) {
	ref, err := uri.Parse(name)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	if ref.Kind.Name != unitKind.Name {
		return nil, Invalid(fmt.Sprintf("%s is not a computing unit", name), nil)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	unit, err := s.Store.GetResource(ctx, rid)
	if err != nil {
		return nil, NotFound("computing unit " + rid.String())
	}
	return unit, nil
}

func (s *Service) resourceByURI(ctx context.Context, caller *auth.Caller, name string, kind *kinds.Kind) (*store.Resource, error) {
	ref, err := uri.Parse(name)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	if kind != nil && ref.Kind.Name != kind.Name {
		return nil, Invalid(fmt.Sprintf("%s is not a %s", name, kind.Name), nil)
	}
	rid, err := uuid.Parse(ref.Rid)
	if err != nil {
		return nil, Invalid(err.Error(), nil)
	}
	return s.Get(ctx, caller, &ref.Kind, rid)
}

func uriString(u *api.Uri) string {
	if u == nil {
		return ""
	}
	return string(*u)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
