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

func (m Mux) Endpoint(ctx context.Context, rid string, spec api.ComputingUnitSpec) (string, error) {
	p, err := m.pick(spec)
	if err != nil {
		return "", err
	}
	return p.Endpoint(ctx, rid, spec)
}

func (m Mux) Terminate(ctx context.Context, rid string, spec api.ComputingUnitSpec) error {
	p, err := m.pick(spec)
	if err != nil {
		return err
	}
	return p.Terminate(ctx, rid, spec)
}
