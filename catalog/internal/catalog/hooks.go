package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// prepareSpec normalizes a spec for its kind and validates it against the contract's schema.
func (s *Service) prepareSpec(ctx context.Context, caller *auth.Caller, k kinds.Kind, name string, spec json.RawMessage) (json.RawMessage, error) {
	var doc map[string]any
	if err := json.Unmarshal(spec, &doc); err != nil {
		return nil, Invalid("the spec must be a JSON object", nil)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	switch k.Name {
	case "operator":
		// A function's ports, settings and columns are what its code says.
		if err := functionOperator(doc); err != nil {
			return nil, Invalid("the function: "+err.Error(), map[string]any{"field": "implementation.python.code"})
		}
		// A custom operator's type is its name unless the author named it.
		if t, _ := doc["operatorType"].(string); strings.TrimSpace(t) == "" {
			doc["operatorType"] = name
		}
	case "workflow":
		if _, ok := doc["operators"]; !ok {
			doc["operators"] = []any{}
		}
		if _, ok := doc["links"]; !ok {
			doc["links"] = []any{}
		}
		placesOfOperators(doc)
		if err := refuseEngineOnly(doc); err != nil {
			return nil, err
		}
	}
	normalized := mustJSON(doc)
	if err := k.ValidateSpec(normalized); err != nil {
		var ve *kinds.ValidationError
		if errors.As(err, &ve) {
			return nil, Invalid("the spec does not match "+k.Spec, map[string]any{"schema": k.Spec, "errors": ve.Err.Error()})
		}
		return nil, err
	}
	if k.Name == "warehouse" {
		if err := s.checkWarehouse(ctx, caller, normalized); err != nil {
			return nil, err
		}
	}
	if k.Name == "computing-unit" {
		// A node made from a profile is what the profile says, where it says nothing itself.
		return s.nodesFromProfiles(ctx, caller, normalized)
	}
	return normalized, nil
}

// afterCreate gives a kind what it needs outside the store; an error undoes the creation.
func (s *Service) afterCreate(ctx context.Context, r *store.Resource) error {
	if r.Kind == "warehouse" {
		return s.provisionWarehouse(ctx, r)
	}
	if r.Kind != "computing-unit" {
		return nil
	}
	var spec api.ComputingUnitSpec
	if err := json.Unmarshal(r.Spec, &spec); err != nil {
		return err
	}
	identity, err := s.unitIdentityFor(ctx, r, spec)
	if err != nil || identity == nil {
		return err
	}
	return s.recordUnitIdentity(ctx, r, identity)
}

// recordUnitIdentity writes the identity into the unit's status, which starts as pending.
func (s *Service) recordUnitIdentity(ctx context.Context, r *store.Resource, identity *api.UnitIdentity) error {
	var status api.ComputingUnitStatus
	_ = json.Unmarshal(r.Status, &status)
	if status.Phase == "" {
		status.Phase = api.ComputingUnitStatusPhasePending
	}
	status.Identity = identity
	updated, err := s.Store.UpdateStatus(ctx, r.RID, mustJSON(status))
	if err != nil {
		return err
	}
	*r = *updated
	return nil
}

// unitIdentityFor is the identity a unit runs with: minted by the catalog for a unit it
// provisions (the credential goes to the secret store, never the database), or the operator's
// client for a static unit that names one; nil for a static unit without.
func (s *Service) unitIdentityFor(ctx context.Context, r *store.Resource, spec api.ComputingUnitSpec) (*api.UnitIdentity, error) {
	switch spec.Provider {
	case api.UnitProviderKubernetes:
		clientID := "unit-" + r.RID.String()
		w, err := s.Workloads.CreateWorkload(ctx, clientID, "Texera unit "+r.Name)
		if err != nil {
			return nil, Unavailable("identity provider", err)
		}
		if err := s.Secrets.Put(ctx, unitSecretPath(r.RID), map[string]string{"clientId": w.ClientID, "secret": w.Secret}); err != nil {
			return nil, Unavailable("secret store", err)
		}
		return &api.UnitIdentity{ClientId: w.ClientID, Subject: w.Subject}, nil
	default:
		if spec.ClientId == nil || *spec.ClientId == "" {
			return nil, nil
		}
		subject, err := s.Workloads.WorkloadSubject(ctx, *spec.ClientId)
		if errors.Is(err, ports.ErrWorkloadNotFound) {
			return nil, Invalid("the identity provider has no client "+*spec.ClientId, nil)
		}
		if err != nil {
			return nil, Unavailable("identity provider", err)
		}
		return &api.UnitIdentity{ClientId: *spec.ClientId, Subject: subject}, nil
	}
}

// beforeUpdate refuses a spec change a kind cannot take.
func (s *Service) beforeUpdate(ctx context.Context, r *store.Resource, spec json.RawMessage) error {
	if r.Kind == "warehouse" {
		// The tables stay where they were written: a warehouse's key can change, its place cannot.
		var current, next api.WarehouseSpec
		_ = json.Unmarshal(r.Spec, &current)
		if err := json.Unmarshal(spec, &next); err != nil {
			return err
		}
		if !samePlace(current, next) {
			return Invalid("where a warehouse keeps its tables cannot change; make a new warehouse", nil)
		}
		return nil
	}
	if r.Kind != "computing-unit" {
		return nil
	}
	var current, next api.ComputingUnitSpec
	_ = json.Unmarshal(r.Spec, &current)
	if err := json.Unmarshal(spec, &next); err != nil {
		return err
	}
	if next.Provider != current.Provider {
		return Invalid("a unit's provider cannot change; make a new unit", nil)
	}
	// A change rolls the unit: nothing may be running on it.
	for _, phase := range []api.ExecutionPhase{api.ExecutionPhasePending, api.ExecutionPhaseProvisioning, api.ExecutionPhaseRunning} {
		running, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: "execution", Fields: map[string]string{"/spec/computingUnit": URI(r).String(), "/status/phase": string(phase)}, Limit: 1})
		if err != nil {
			return err
		}
		if len(running) > 0 {
			return Conflict("running", fmt.Sprintf("execution %s is %s on %s; cancel it or wait", running[0].RID, phase, r.Name), map[string]any{"execution": running[0].RID.String()})
		}
	}
	return nil
}

// afterUpdate applies a changed spec outside the store: a provisioned unit rolls to it at
// once, a static unit's identity follows its client, a warehouse's key reaches the lake. A
// unit given other packages has none of them installed until a run installs them.
func (s *Service) afterUpdate(ctx context.Context, before, r *store.Resource) error {
	if r.Kind == "warehouse" {
		return s.provisionWarehouse(ctx, r)
	}
	if r.Kind != "computing-unit" {
		return nil
	}
	var was, spec api.ComputingUnitSpec
	_ = json.Unmarshal(before.Spec, &was)
	if err := json.Unmarshal(r.Spec, &spec); err != nil {
		return err
	}
	if environmentKey(&was) != environmentKey(&spec) {
		if err := s.forgetInstalled(ctx, r); err != nil {
			return err
		}
	}
	switch spec.Provider {
	case api.UnitProviderKubernetes:
		if _, err := s.Units.Endpoint(ctx, r.RID.String(), spec, s.workloadSource(r)); err != nil {
			return Unavailable("unit provider", err)
		}
	default:
		identity, err := s.unitIdentityFor(ctx, r, spec)
		if err != nil {
			return err
		}
		if identity != nil || unitIdentity(r) != nil {
			return s.recordUnitIdentity(ctx, r, identity)
		}
	}
	return nil
}

// beforeDelete cleans up what a kind holds outside the store.
func (s *Service) beforeDelete(ctx context.Context, r *store.Resource) error {
	switch r.Kind {
	case "credential":
		path := secretPath(r)
		if err := s.Secrets.Delete(ctx, path); err != nil && !errors.Is(err, ports.ErrSecretNotFound) {
			return err
		}
	case "computing-unit":
		// Deleting the resource releases what the provider holds for it, and the identity the
		// catalog minted for it; a static unit's client is its operator's.
		var spec api.ComputingUnitSpec
		if err := json.Unmarshal(r.Spec, &spec); err == nil {
			if err := s.Units.Terminate(ctx, r.RID.String(), spec); err != nil {
				return Unavailable("unit provider", err)
			}
			if spec.Provider == api.UnitProviderKubernetes {
				if identity := unitIdentity(r); identity != nil {
					if err := s.Workloads.DeleteWorkload(ctx, identity.ClientId); err != nil {
						return Unavailable("identity provider", err)
					}
				}
				if err := s.Secrets.Delete(ctx, unitSecretPath(r.RID)); err != nil && !errors.Is(err, ports.ErrSecretNotFound) {
					return err
				}
			}
		}
	case "execution":
		// The execution's tables go with it.
		if err := s.Lake.DropNamespace(ctx, s.warehouseOf(ctx, r), executionNamespace(r.RID)); err != nil {
			return Unavailable("lake", err)
		}
	case "warehouse":
		return s.removeWarehouse(ctx, r)
	}
	return nil
}
