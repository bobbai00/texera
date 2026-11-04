package catalog

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
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

// Run starts an execution of a workflow version: the unit and the environment are resolved
// (request, then the workflow's defaults, then the project's, then the deployment's), the
// plan is compiled, the execution is created under the workflow, and a goroutine builds the
// environment and starts the run. With WaitSeconds the call waits for the run to end.
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
	unit, err := s.resourceByURI(ctx, caller, unitName, &unitKind)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.RunOn, unit.RID); err != nil {
		return nil, err
	}
	client, status, err := s.unitClient(ctx, unit)
	if err != nil {
		return nil, err
	}
	if status.Phase != api.ComputingUnitStatusPhaseReady {
		return nil, Conflict("unit_not_ready", fmt.Sprintf("the unit %s is %s", unit.Name, status.Phase), nil)
	}

	var env *store.Resource
	envVno := 0
	envName := firstNonEmpty(in.Environment, uriString(spec.DefaultEnvironment), uriString(project.DefaultEnvironment), uriString(settings.Defaults.Environment))
	if envName != "" {
		env, err = s.resourceByURI(ctx, caller, envName, &environmentKind)
		if err != nil {
			return nil, err
		}
		if err := s.require(ctx, caller, authz.Use, env.RID); err != nil {
			return nil, err
		}
		ref, _ := uri.Parse(envName)
		envVno = ref.Vno
		if envVno == 0 {
			envVno = env.HeadVno
		}
		if _, err := s.Store.GetVersion(ctx, env.RID, envVno); err != nil {
			return nil, NotFound(fmt.Sprintf("version %d of environment %s", envVno, env.Name))
		}
	}

	unitURI := URI(unit).String()
	running, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "execution", ParentRID: &wf.RID, Fields: map[string]string{"/spec/computingUnit": unitURI, "/status/phase": "running"}, Limit: 1})
	if err != nil {
		return nil, err
	}
	if len(running) > 0 {
		return nil, Conflict("running", fmt.Sprintf("execution %s of this workflow is still running on %s; cancel it or wait", running[0].RID, unit.Name), map[string]any{"execution": running[0].RID.String()})
	}

	plan, err := s.buildPlan(ctx, caller, spec)
	if err != nil {
		return nil, err
	}

	name := in.Name
	if name == "" {
		name = fmt.Sprintf("run %s", time.Now().UTC().Format("2006-01-02 15:04:05"))
	}
	execSpec := api.ExecutionSpec{Workflow: api.Uri(URI(wf).WithVersion(version.Vno).String()), ComputingUnit: api.Uri(unitURI)}
	if env != nil {
		e := api.Uri(URI(env).WithVersion(envVno).String())
		execSpec.Environment = &e
	}
	if len(plan.InputURIs) > 0 {
		inputs := make([]api.Uri, len(plan.InputURIs))
		for i, u := range plan.InputURIs {
			inputs[i] = api.Uri(u)
		}
		execSpec.Inputs = &inputs
	}
	if len(in.Parameters) > 0 {
		execSpec.Parameters = &in.Parameters
	}
	exec, _, err := s.Store.CreateResource(ctx, store.NewResource{
		Kind: "execution", Name: name, ParentRID: &wf.RID, ProjectRID: wf.ProjectRID, OwnerPID: caller.PID(), CreatedByPID: caller.PID(),
		Spec: mustJSON(execSpec), Status: mustJSON(api.ExecutionStatus{Phase: api.ExecutionPhasePending}), Origin: caller.Origin,
	})
	if err != nil {
		return nil, wrap(err, "execution")
	}
	s.Relay.Flush(ctx)
	execURI := URI(exec).String()
	if edges := usedEdges(exec, execURI, plan); len(edges) > 0 {
		if err := s.Store.AddEdges(ctx, edges); err != nil {
			s.Log.Warn("used edges", "execution", exec.RID, "err", err)
		}
	}
	_, _ = s.Store.MergeStatus(ctx, wf.RID, mustJSON(map[string]any{"lastExecution": exec.RID.String()}))

	token, err := s.Identity.ServiceToken(ctx)
	if err != nil {
		return nil, Unavailable("identity provider", err)
	}
	req := engine.ExecutionStartRequest{
		Eid: exec.RID.String(),
		Workflow: struct {
			Rid string `json:"rid"`
			Vno int32  `json:"vno"`
		}{Rid: wf.RID.String(), Vno: int32(version.Vno)},
		Name:        &name,
		LogicalPlan: plan.Plan,
		ResultStore: &engine.ResultStore{CatalogUri: s.Config.IcebergCatalogURI, Warehouse: s.Config.IcebergWarehouse, Namespace: "e_" + strings.ReplaceAll(exec.RID.String(), "-", "")},
		Reporting:   engine.Reporting{LineageUrl: s.Config.LineageCallbackURL, Token: token},
		Actor:       caller.PID().String(),
	}
	if len(plan.Inputs) > 0 {
		inputs := plan.Inputs
		req.Inputs = &inputs
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

// executionUnit returns the client of the unit an execution runs on.
func (s *Service) executionUnit(ctx context.Context, caller *auth.Caller, exec *store.Resource) (*engine.Unit, error) {
	var spec api.ExecutionSpec
	_ = json.Unmarshal(exec.Spec, &spec)
	unit, err := s.resourceByURI(ctx, caller, string(spec.ComputingUnit), &unitKind)
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
	table := ""
	var st api.ExecutionStatus
	_ = json.Unmarshal(r.Status, &st)
	if st.Ports != nil {
		for _, p := range *st.Ports {
			if p.OperatorID == operatorID && p.PortID == portID && p.Table != nil {
				table = *p.Table
			}
		}
	}
	client, err := s.executionUnit(ctx, caller, r)
	if err != nil {
		return nil, err
	}
	page, err := client.Result(ctx, eid.String(), operatorID, portID, table, offset, limit)
	if err != nil {
		return nil, Unavailable("unit", err)
	}
	return page, nil
}

// SavePortInput is what SavePort needs.
type SavePortInput struct {
	Dataset *uuid.UUID
	Name    string
	Path    string
	Message *string
}

// SavePort writes an output port's rows as a CSV file into a dataset version and records
// that the version was derived from the port.
func (s *Service) SavePort(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID, operatorID, portID string, in SavePortInput) (*store.Resource, *store.Version, error) {
	exec, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, nil, err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(exec.Status, &st)
	if st.Phase != api.ExecutionPhaseCompleted {
		return nil, nil, Conflict("not_completed", "the execution has not completed", nil)
	}
	client, err := s.executionUnit(ctx, caller, exec)
	if err != nil {
		return nil, nil, err
	}
	table := ""
	if st.Ports != nil {
		for _, p := range *st.Ports {
			if p.OperatorID == operatorID && p.PortID == portID && p.Table != nil {
				table = *p.Table
			}
		}
	}
	tmp, err := os.CreateTemp("", "texera-save-*.csv")
	if err != nil {
		return nil, nil, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	w := csv.NewWriter(tmp)
	var offset int64
	wroteHeader := false
	for {
		page, err := client.Result(ctx, eid.String(), operatorID, portID, table, offset, 1000)
		if err != nil {
			return nil, nil, Unavailable("unit", err)
		}
		if !wroteHeader {
			header := make([]string, len(page.Schema))
			for i, a := range page.Schema {
				header[i] = a.AttributeName
			}
			if err := w.Write(header); err != nil {
				return nil, nil, err
			}
			wroteHeader = true
		}
		for _, row := range page.Rows {
			cells := make([]string, len(row))
			for i, c := range row {
				cells[i] = cellString(c)
			}
			if err := w.Write(cells); err != nil {
				return nil, nil, err
			}
		}
		offset += int64(len(page.Rows))
		if len(page.Rows) == 0 || (page.Total != nil && offset >= *page.Total) {
			break
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, nil, err
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		return nil, nil, err
	}
	path := in.Path
	if path == "" {
		path = operatorID + ".csv"
	}
	var dataset *store.Resource
	if in.Dataset != nil {
		dataset, err = s.Get(ctx, caller, &datasetKind, *in.Dataset)
		if err != nil {
			return nil, nil, err
		}
		if err := s.require(ctx, caller, authz.Write, dataset.RID); err != nil {
			return nil, nil, err
		}
	} else {
		name := in.Name
		if name == "" {
			name = fmt.Sprintf("%s %s", operatorID, time.Now().UTC().Format("2006-01-02 15:04:05"))
		}
		dataset, _, err = s.Create(ctx, caller, CreateInput{Kind: datasetKind, Name: name, Parent: exec.ProjectRID, Spec: json.RawMessage(`{"format":"csv"}`)})
		if err != nil {
			return nil, nil, err
		}
	}
	if _, err := s.Upload(ctx, caller, datasetKind, dataset.RID, path, tmp, "text/csv"); err != nil {
		return nil, nil, err
	}
	message := in.Message
	if message == nil {
		m := "saved from " + operatorID + "/" + portID + " of execution " + eid.String()
		message = &m
	}
	dataset, version, err := s.Commit(ctx, caller, datasetKind, dataset.RID, message)
	if err != nil {
		return nil, nil, err
	}
	portURI := URI(exec).With("operators", operatorID, "ports", portID).String()
	toRID := exec.RID
	execRID := exec.RID
	if err := s.Store.AddEdges(ctx, []store.Edge{{From: URI(dataset).WithVersion(version.Vno).String(), Relation: "derivedFrom", To: portURI, FromRID: dataset.RID, ToRID: &toRID, ExecutionRID: &execRID}}); err != nil {
		s.Log.Warn("derivedFrom edge", "dataset", dataset.RID, "err", err)
	}
	return dataset, version, nil
}

func cellString(c any) string {
	switch v := c.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	case fmt.Stringer:
		return v.String()
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// resourceByURI resolves a resource URI of an expected kind the caller may read.
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
