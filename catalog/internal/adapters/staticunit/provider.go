// Package staticunit is the UnitProvider adapter for units that already run: the dev stack's
// unit under sbt, or any engine deployment reachable at a URL. Nothing is provisioned; the
// endpoint is the spec's.
package staticunit

import (
	"context"
	"errors"

	"github.com/apache/texera/catalog/internal/api"
)

// Provider implements ports.UnitProvider.
type Provider struct{}

// Endpoint returns the spec's endpoint.
func (Provider) Endpoint(_ context.Context, spec api.ComputingUnitSpec) (string, error) {
	if spec.Provider != api.UnitProviderStatic {
		return "", errors.New("only static units are provided in this deployment")
	}
	if spec.Endpoint == nil || *spec.Endpoint == "" {
		return "", errors.New("a static unit needs an endpoint")
	}
	return *spec.Endpoint, nil
}

// Terminate does nothing: a static unit is not the catalog's to stop.
func (Provider) Terminate(context.Context, api.ComputingUnitSpec) error { return nil }
