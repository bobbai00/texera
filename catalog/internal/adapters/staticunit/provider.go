// Package staticunit is the UnitProvider adapter for units that already run: the dev stack's
// unit under sbt, or any engine deployment reachable at a URL. Nothing is provisioned; the
// endpoint is the spec's.
package staticunit

import (
	"context"
	"errors"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
)

// Provider implements ports.UnitProvider.
type Provider struct{}

// Endpoint returns the spec's endpoint; the unit's identity is the operator's to configure.
func (Provider) Endpoint(_ context.Context, _ string, spec api.ComputingUnitSpec, _ ports.WorkloadSource) (string, error) {
	if spec.Provider != api.UnitProviderStatic {
		return "", errors.New("only static units are provided in this deployment")
	}
	if spec.Endpoint == nil || *spec.Endpoint == "" {
		return "", errors.New("a static unit needs an endpoint")
	}
	return *spec.Endpoint, nil
}

// Terminate does nothing: a static unit is not the catalog's to stop.
func (Provider) Terminate(context.Context, string, api.ComputingUnitSpec) error { return nil }

// Offers: a static unit is there already.
func (Provider) Offers(context.Context, api.ComputingUnitSpec) error { return nil }
