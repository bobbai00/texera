package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// What the unit installed is the catalog's record of its last build.
	next.Installed = current.Installed
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

// SyncOperators brings the engine's operators of a unit into Texera, one resource per type,
// versioned by the engine that provides them, through the release ledger: an operator Texera's
// admins changed keeps their change, and one they deleted stays gone, which is how they take an
// operator from everyone. It runs at startup and whenever a unit's engine changes. The engine's
// own operators, which no workflow names, are left out.
func (s *Service) SyncOperators(ctx context.Context, unit *store.Resource) error {
	sys := s.System()
	root := s.Root()
	if sys == nil || root == nil {
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
	changed := 0
	for _, op := range list.Operators {
		if engineOnly[op.OperatorType] {
			// Not one anybody calls: no workflow names it, so Texera does not offer it.
			s.dropOperatorType(ctx, caller, root.RID, op.OperatorType)
			continue
		}
		spec := api.OperatorSpec{OperatorType: op.OperatorType, DisplayName: &op.UserFriendlyName, Group: &op.OperatorGroupName, Description: op.OperatorDescription, PropertiesSchema: op.JsonSchema}
		if ports := portSpecs(op.InputPorts, "input"); len(ports) > 0 {
			spec.InputPorts = &ports
		}
		if ports := portSpecs(op.OutputPorts, "output"); len(ports) > 0 {
			spec.OutputPorts = &ports
		}
		if op.Requires != nil {
			spec.Requires = &api.RuntimeSpec{Isolation: op.Requires.Isolation, Resources: op.Requires.Resources}
		}
		description := ""
		if op.OperatorDescription != nil {
			description = *op.OperatorDescription
		}
		before, _ := s.Store.GetShipped(ctx, "operator", op.OperatorType)
		r, err := s.ship(ctx, caller, shipment{
			kind: "operator", name: op.OperatorType, description: description, spec: mustJSON(spec),
			status: mustJSON(api.OperatorStatus{Engine: &engineID}), message: "updated by engine " + engineID, typed: true,
		})
		if err != nil {
			s.Log.Warn("sync operator", "type", op.OperatorType, "err", err)
			continue
		}
		if r != nil && (before == nil || before.Digest != ShippedDigest(r.Spec, r.Description)) {
			changed++
		}
	}
	if changed > 0 {
		s.Log.Info("operators synced", "unit", unit.Name, "engine", engineID, "changed", changed, "total", len(list.Operators))
	}
	return nil
}

// dropOperatorType deletes Texera's operator resources of a type, as an earlier sync made, and
// forgets that a release shipped it.
func (s *Service) dropOperatorType(ctx context.Context, caller *auth.Caller, project uuid.UUID, operatorType string) {
	named, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "operator", ParentRID: &project, Name: operatorType, Limit: 20})
	if err != nil {
		return
	}
	k, _ := kinds.ByName("operator")
	for _, r := range ofOperatorType(named, operatorType) {
		if err := s.Delete(ctx, caller, &k, r.RID); err != nil {
			s.Log.Warn("drop engine operator", "type", operatorType, "err", err)
		}
	}
	_ = s.Store.ForgetShipped(ctx, "operator", operatorType)
}

// ofOperatorType keeps the operator resources whose spec is of exactly this type.
func ofOperatorType(resources []store.Resource, operatorType string) []store.Resource {
	var out []store.Resource
	for _, r := range resources {
		var spec struct {
			OperatorType string `json:"operatorType"`
		}
		if json.Unmarshal(r.Spec, &spec) == nil && spec.OperatorType == operatorType {
			out = append(out, r)
		}
	}
	return out
}

// portSpecs reads the ports a unit describes for an operator type. The engine sends each port
// as its proto, keyed by its identity, and the catalog names it "input-1" or "output-1":
//
//	{"id": {"id": 1, "internal": false}, "displayName": "right", "disallowMultiLinks": false}
//
// An input port takes several links unless the engine says otherwise; their rows arrive as
// one input. Internal ports belong to the engine's physical plan and are left out.
func portSpecs(ports []any, direction string) []api.OperatorPortSpec {
	var out []api.OperatorPortSpec
	for _, p := range ports {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		identity, ok := m["id"].(map[string]any)
		if !ok {
			continue
		}
		if internal, _ := identity["internal"].(bool); internal {
			continue
		}
		number, _ := identity["id"].(float64)
		spec := api.OperatorPortSpec{PortID: fmt.Sprintf("%s-%d", direction, int(number))}
		if d, ok := m["displayName"].(string); ok && d != "" {
			spec.DisplayName = &d
		}
		if direction == "input" {
			if disallow, _ := m["disallowMultiLinks"].(bool); !disallow {
				several := true
				spec.AllowMultiInputs = &several
			}
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
