// Package unitmux is a ports.UnitProvider that dispatches on a unit's provider, so a
// deployment can offer static units and Kubernetes units side by side.
package unitmux

import (
	"context"
	"fmt"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
)

type Mux map[api.UnitProvider]ports.UnitProvider

func (m Mux) pick(spec api.ComputingUnitSpec) (ports.UnitProvider, error) {
	p, ok := m[spec.Provider]
	if !ok {
		return nil, fmt.Errorf("units of provider %q are not offered in this deployment", spec.Provider)
	}
	return p, nil
}

func (m Mux) Endpoint(ctx context.Context, rid string, spec api.ComputingUnitSpec, identity ports.WorkloadSource) (string, error) {
	p, err := m.pick(spec)
	if err != nil {
		return "", err
	}
	return p.Endpoint(ctx, rid, spec, identity)
}

// Terminate releases what the unit holds; a unit of a provider this deployment does not offer
// holds nothing here, so it is not an error.
func (m Mux) Terminate(ctx context.Context, rid string, spec api.ComputingUnitSpec) error {
	p, ok := m[spec.Provider]
	if !ok {
		return nil
	}
	return p.Terminate(ctx, rid, spec)
}

// Offers says why this deployment cannot start such a unit: a provider it does not offer, or
// what the provider says.
func (m Mux) Offers(ctx context.Context, spec api.ComputingUnitSpec) error {
	p, ok := m[spec.Provider]
	if !ok {
		if spec.Provider == api.UnitProviderKubernetes {
			return fmt.Errorf("this deployment starts no units from profiles: its own unit runs everything")
		}
		return fmt.Errorf("units of provider %q are not offered in this deployment", spec.Provider)
	}
	return p.Offers(ctx, spec)
}
