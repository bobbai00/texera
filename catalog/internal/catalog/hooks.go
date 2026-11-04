package catalog

import (
	"context"
	"encoding/json"
	"errors"
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
	case "conversation":
		if t, _ := doc["template"].(string); strings.TrimSpace(t) == "" {
			tpl, err := s.defaultTemplate(ctx, caller)
			if err != nil {
				return nil, err
			}
			doc["template"] = tpl
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
	return normalized, nil
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
		// Deleting the resource releases what the provider holds for it.
		var spec api.ComputingUnitSpec
		if err := json.Unmarshal(r.Spec, &spec); err == nil {
			if err := s.Units.Terminate(ctx, r.RID.String(), spec); err != nil {
				return Unavailable("unit provider", err)
			}
		}
	}
	return nil
}
