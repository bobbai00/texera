package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// unitClient returns a client for a unit and its live status, probing its health.
func (s *Service) unitClient(ctx context.Context, unit *store.Resource) (*engine.Unit, *api.ComputingUnitStatus, error) {
	var spec api.ComputingUnitSpec
	if err := json.Unmarshal(unit.Spec, &spec); err != nil {
		return nil, nil, err
	}
	status := s.unitStatus(ctx, unit, spec)
	if status.Phase != api.ComputingUnitStatusPhaseReady {
		return nil, status, nil
	}
	endpoint, err := s.Units.Endpoint(ctx, unit.RID.String(), spec, s.workloadSource(unit))
	if err != nil {
		return nil, status, Unavailable("unit provider", err)
	}
	token, err := s.Identity.ServiceToken(ctx)
	if err != nil {
		return nil, status, Unavailable("identity provider", err)
	}
	client, err := engine.NewUnit(endpoint, token)
	if err != nil {
		return nil, status, err
	}
	return client, status, nil
}

// unitStatus probes a unit and records its status when it changed.
func (s *Service) unitStatus(ctx context.Context, unit *store.Resource, spec api.ComputingUnitSpec) *api.ComputingUnitStatus {
	var current api.ComputingUnitStatus
	_ = json.Unmarshal(unit.Status, &current)
	if current.Phase == api.ComputingUnitStatusPhaseTerminated {
		return &current
	}
	next := api.ComputingUnitStatus{Phase: api.ComputingUnitStatusPhasePending, Identity: current.Identity}
	endpoint, err := s.Units.Endpoint(ctx, unit.RID.String(), spec, s.workloadSource(unit))
	switch {
	case err != nil:
		next.Phase = api.ComputingUnitStatusPhaseFailed
		msg := err.Error()
		next.Message = &msg
	case endpoint == "":
		next.Phase = api.ComputingUnitStatusPhasePending
	default:
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		client, err := engine.NewUnit(endpoint, "")
		var health *engine.UnitHealth
		if err == nil {
			health, err = client.Health(probe)
		}
		if err != nil {
			next.Phase = api.ComputingUnitStatusPhasePending
			msg := "not reachable: " + err.Error()
			next.Message = &msg
		} else {
			next.Phase = api.ComputingUnitStatusPhaseReady
			if health.Version != nil && *health.Version != "" {
				next.Engine = &api.EngineStatus{Version: health.Version, Digest: health.Version}
			}
		}
	}
	next.ComputingNodes = nodesOf(spec, next.Phase == api.ComputingUnitStatusPhaseReady)
	next.Environments = current.Environments
	if string(mustJSON(next)) != string(mustJSON(current)) {
		if r, err := s.Store.UpdateStatus(ctx, unit.RID, mustJSON(next)); err == nil {
			*unit = *r
		}
	}
	return &next
}

// nodesOf renders the unit's computing nodes: the spec's, or one master for a static unit.
func nodesOf(spec api.ComputingUnitSpec, ready bool) *[]api.ComputingNodeStatus {
	var nodes []api.ComputingNodeStatus
	if spec.ComputingNodes != nil {
		for _, n := range *spec.ComputingNodes {
			nodes = append(nodes, api.ComputingNodeStatus{Name: n.Name, Role: api.ComputingNodeStatusRole(n.Role), Ready: ready})
		}
	}
	if len(nodes) == 0 {
		nodes = []api.ComputingNodeStatus{{Name: "master", Role: api.ComputingNodeStatusRoleMaster, Ready: ready}}
	}
	return &nodes
}

// Available lists the units the caller may run on, with live status, in a scope when one is
// given or the call is made in a chat.
func (s *Service) Available(ctx context.Context, caller *auth.Caller, scope *uuid.UUID) ([]store.Resource, error) {
	page, err := s.List(ctx, caller, &unitKind, ListFilter{Scope: scope, Limit: 200})
	if err != nil {
		return nil, err
	}
	var out []store.Resource
	for i := range page.Items {
		unit := page.Items[i]
		var spec api.ComputingUnitSpec
		_ = json.Unmarshal(unit.Spec, &spec)
		status := s.unitStatus(ctx, &unit, spec)
		if status.Phase == api.ComputingUnitStatusPhaseTerminated {
			continue
		}
		out = append(out, unit)
	}
	return out, nil
}

// Unit returns a unit with a fresh status.
func (s *Service) Unit(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*store.Resource, error) {
	unit, err := s.Get(ctx, caller, &unitKind, rid)
	if err != nil {
		return nil, err
	}
	var spec api.ComputingUnitSpec
	_ = json.Unmarshal(unit.Spec, &spec)
	s.unitStatus(ctx, unit, spec)
	return unit, nil
}

// Terminate stops a unit.
func (s *Service) Terminate(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*store.Resource, error) {
	unit, err := s.Get(ctx, caller, &unitKind, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, rid); err != nil {
		return nil, err
	}
	var spec api.ComputingUnitSpec
	_ = json.Unmarshal(unit.Spec, &spec)
	if err := s.Units.Terminate(ctx, rid.String(), spec); err != nil {
		return nil, Unavailable("unit provider", err)
	}
	// The identity stays: a terminated unit keeps its grants and can come back.
	r, err := s.Store.UpdateStatus(ctx, rid, mustJSON(api.ComputingUnitStatus{Phase: api.ComputingUnitStatusPhaseTerminated, ComputingNodes: nodesOf(spec, false), Identity: unitIdentity(unit)}))
	return r, wrap(err, "computing unit")
}

// unitIdentity is the identity recorded in a unit's status, nil when it has none.
func unitIdentity(unit *store.Resource) *api.UnitIdentity {
	var status api.ComputingUnitStatus
	if err := json.Unmarshal(unit.Status, &status); err != nil {
		return nil
	}
	return status.Identity
}

// unitSecretPath is where the secret store keeps the credential of a unit the catalog minted.
func unitSecretPath(rid uuid.UUID) string { return "units/" + rid.String() }

// workloadSource hands a provider the unit's credential: the identity from its status, the
// secret from the secret store, read only when the provider asks.
func (s *Service) workloadSource(unit *store.Resource) ports.WorkloadSource {
	return func(ctx context.Context) (ports.Workload, error) {
		identity := unitIdentity(unit)
		if identity == nil {
			return ports.Workload{}, errors.New("the unit has no identity")
		}
		fields, err := s.Secrets.Get(ctx, unitSecretPath(unit.RID))
		if err != nil {
			return ports.Workload{}, err
		}
		return ports.Workload{ClientID: identity.ClientId, Secret: fields["secret"], Subject: identity.Subject}, nil
	}
}

// Nodes lists a unit's computing nodes.
func (s *Service) Nodes(ctx context.Context, caller *auth.Caller, rid uuid.UUID) ([]api.ComputingNodeStatus, error) {
	unit, err := s.Unit(ctx, caller, rid)
	if err != nil {
		return nil, err
	}
	var status api.ComputingUnitStatus
	_ = json.Unmarshal(unit.Status, &status)
	if status.ComputingNodes == nil {
		return []api.ComputingNodeStatus{}, nil
	}
	return *status.ComputingNodes, nil
}

// UnitOperators lists the operator types a unit's engine provides.
func (s *Service) UnitOperators(ctx context.Context, caller *auth.Caller, rid uuid.UUID, q, group string) (*engine.OperatorTypeList, error) {
	unit, err := s.Get(ctx, caller, &unitKind, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.RunOn, rid); err != nil {
		return nil, err
	}
	client, status, err := s.unitClient(ctx, unit)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, Conflict("unit_not_ready", "the unit is "+string(status.Phase), nil)
	}
	list, err := client.Operators(ctx)
	if err != nil {
		return nil, UnitFailed(err)
	}
	if q == "" && group == "" {
		return list, nil
	}
	filtered := &engine.OperatorTypeList{Operators: []engine.OperatorType{}, Groups: list.Groups}
	for _, op := range list.Operators {
		if group != "" && !strings.EqualFold(op.OperatorGroupName, group) {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(op.OperatorType+" "+op.UserFriendlyName), strings.ToLower(q)) {
			continue
		}
		filtered.Operators = append(filtered.Operators, op)
	}
	return filtered, nil
}

// BuildEnvironment asks a unit to build an environment version in the background.
func (s *Service) BuildEnvironment(ctx context.Context, caller *auth.Caller, rid uuid.UUID, vno int, unitName string) (*api.EnvironmentBuild, error) {
	env, err := s.Get(ctx, caller, &environmentKind, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Use, rid); err != nil {
		return nil, err
	}
	if vno <= 0 {
		vno = env.HeadVno
	}
	if _, err := s.Store.GetVersion(ctx, rid, vno); err != nil {
		return nil, NotFound("version of the environment")
	}
	settings := s.settingsSpec(ctx)
	unitName = firstNonEmpty(unitName, uriString(s.projectSpec(ctx, env.ProjectRID).DefaultComputingUnit), uriString(settings.Defaults.ComputingUnit))
	if unitName == "" {
		return nil, Conflict("no_unit", "no computing unit to build on", nil)
	}
	unit, err := s.unitByURI(ctx, unitName)
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
	if client == nil {
		return nil, Conflict("unit_not_ready", "the unit is "+string(status.Phase), nil)
	}
	req := environmentRequest(ctx, s, env, vno)
	unitURI := URI(unit).String()
	s.recordBuild(ctx, env, vno, unitURI, "building", "")
	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		_ = s.ensureEnvironment(bg, client, env, vno, *req, unit)
	}()
	return &api.EnvironmentBuild{ComputingUnit: api.Uri(unitURI), Vno: api.Vno(vno), State: api.EnvironmentBuildStateBuilding, At: time.Now().UTC()}, nil
}

// SyncOperators mirrors a unit's operator registry into operator resources of the system
// project: one per type, versioned by the engine that provides it. It runs at startup and
// whenever a unit's engine changes.
func (s *Service) SyncOperators(ctx context.Context, unit *store.Resource) error {
	sys := s.System()
	project := s.SystemProject()
	if sys == nil || project == nil {
		return nil
	}
	client, status, err := s.unitClient(ctx, unit)
	if err != nil || client == nil {
		return err
	}
	engineID := "unknown"
	if status.Engine != nil && status.Engine.Version != nil {
		engineID = *status.Engine.Version
	}
	list, err := client.Operators(ctx)
	if err != nil {
		return err
	}
	caller := &auth.Caller{Principal: sys, Service: true}
	k, _ := kinds.ByName("operator")
	count := 0
	for _, op := range list.Operators {
		spec := api.OperatorSpec{OperatorType: op.OperatorType, DisplayName: &op.UserFriendlyName, Group: &op.OperatorGroupName, Description: op.OperatorDescription, PropertiesSchema: op.JsonSchema}
		if ports := portSpecs(op.InputPorts); len(ports) > 0 {
			spec.InputPorts = &ports
		}
		if ports := portSpecs(op.OutputPorts); len(ports) > 0 {
			spec.OutputPorts = &ports
		}
		if op.Requires != nil {
			spec.Requires = &api.RuntimeSpec{Environment: op.Requires.Environment, Isolation: op.Requires.Isolation, Resources: op.Requires.Resources}
		}
		status := mustJSON(api.OperatorStatus{Engine: &engineID})
		existing, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "operator", ParentRID: &project.RID, Name: op.OperatorType, Limit: 1})
		if err != nil {
			return err
		}
		specJSON := mustJSON(spec)
		if len(existing) == 0 {
			desc := op.OperatorDescription
			if _, _, err := s.Create(ctx, caller, CreateInput{Kind: k, Name: op.OperatorType, Description: desc, Parent: &project.RID, Spec: specJSON, Status: status, Owner: &sys.PID}); err != nil {
				s.Log.Warn("seed operator", "type", op.OperatorType, "err", err)
				continue
			}
			count++
			continue
		}
		cur := existing[0]
		curCanon, _ := store.Canonical(cur.Spec)
		newCanon, _ := store.Canonical(specJSON)
		if string(curCanon) != string(newCanon) {
			msg := "updated by engine " + engineID
			if _, _, err := s.UpdateSpec(ctx, caller, k, UpdateSpecInput{RID: cur.RID, Spec: specJSON, Message: &msg}); err != nil {
				s.Log.Warn("update operator", "type", op.OperatorType, "err", err)
				continue
			}
			count++
		}
		if string(cur.Status) == "" || !strings.Contains(string(cur.Status), engineID) {
			_, _ = s.Store.UpdateStatus(ctx, cur.RID, status)
		}
	}
	if count > 0 {
		s.Log.Info("operators synced", "unit", unit.Name, "engine", engineID, "changed", count, "total", len(list.Operators))
	}
	return nil
}

func portSpecs(ports []any) []api.OperatorPortSpec {
	var out []api.OperatorPortSpec
	for _, p := range ports {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["portID"].(string)
		if id == "" {
			continue
		}
		spec := api.OperatorPortSpec{PortID: id}
		if d, ok := m["displayName"].(string); ok && d != "" {
			spec.DisplayName = &d
		}
		if b, ok := m["allowMultiInputs"].(bool); ok && b {
			spec.AllowMultiInputs = &b
		}
		if b, ok := m["isDynamicPort"].(bool); ok && b {
			spec.IsDynamicPort = &b
		}
		out = append(out, spec)
	}
	return out
}

// RunOperatorSync keeps the built-in operators in step with the units, until the context ends.
func (s *Service) RunOperatorSync(ctx context.Context, every time.Duration) {
	synced := map[uuid.UUID]string{}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		units, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "computing-unit", Limit: 100})
		if err == nil {
			for i := range units {
				unit := units[i]
				var spec api.ComputingUnitSpec
				_ = json.Unmarshal(unit.Spec, &spec)
				status := s.unitStatus(ctx, &unit, spec)
				if status.Phase != api.ComputingUnitStatusPhaseReady {
					continue
				}
				engineID := ""
				if status.Engine != nil && status.Engine.Version != nil {
					engineID = *status.Engine.Version
				}
				if synced[unit.RID] == engineID && engineID != "" {
					continue
				}
				if err := s.SyncOperators(ctx, &unit); err != nil {
					s.Log.Warn("operator sync", "unit", unit.Name, "err", err)
					continue
				}
				synced[unit.RID] = engineID
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
