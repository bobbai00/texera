package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/store"
)

// OperatorsList returns the operator registry: the operator metadata of a unit, normalized
// and cached for a minute.
func (s *Server) OperatorsList(ctx context.Context, req api.OperatorsListRequestObject) (api.OperatorsListResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.operatorRegistry(ctx, caller)
	if err != nil {
		return nil, err
	}
	out := api.OperatorTypeList{Groups: list.Groups, Operators: []api.OperatorType{}}
	for _, op := range list.Operators {
		if req.Params.Group != nil && !strings.EqualFold(op.OperatorGroupName, *req.Params.Group) {
			continue
		}
		if req.Params.Q != nil {
			q := strings.ToLower(*req.Params.Q)
			hay := strings.ToLower(op.OperatorType + " " + op.UserFriendlyName + " " + deref(op.OperatorDescription))
			if !strings.Contains(hay, q) {
				continue
			}
		}
		out.Operators = append(out.Operators, op)
	}
	return api.OperatorsList200JSONResponse(out), nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (s *Server) operatorRegistry(ctx context.Context, caller *callerT) (*api.OperatorTypeList, error) {
	s.opsMu.Lock()
	if s.opsCache != nil && time.Since(s.opsCached) < time.Minute {
		c := s.opsCache
		s.opsMu.Unlock()
		return c, nil
	}
	s.opsMu.Unlock()
	unitRes, err := s.pickUnit(ctx, caller, nil, api.WorkflowSpec{})
	if err != nil {
		return nil, err
	}
	var spec api.ComputingUnitSpec
	_ = json.Unmarshal(unitRes.Spec, &spec)
	if spec.Endpoint == nil {
		return nil, &Problem{Status: 503, Code: "unit_unavailable", Message: "no unit endpoint for the operator registry"}
	}
	token, err := s.tokens.Token(ctx)
	if err != nil {
		return nil, unavailable("service token", err)
	}
	list, err := fetchOperators(ctx, *spec.Endpoint, token)
	if err != nil {
		return nil, unavailable("operator registry on "+unitRes.Name, err)
	}
	s.opsMu.Lock()
	s.opsCache, s.opsCached = list, time.Now()
	s.opsMu.Unlock()
	return list, nil
}

// fetchOperators reads the unit's operator registry (OperatorTypeList). The normalizer also
// accepts the legacy engine shape {operatorType, jsonSchema, additionalMetadata{...}}.
func fetchOperators(ctx context.Context, endpoint, token string) (*api.OperatorTypeList, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(endpoint, "/")+"/api/operators", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return normalizeOperators(body)
}

func normalizeOperators(body []byte) (*api.OperatorTypeList, error) {
	var raw struct {
		Operators []map[string]any `json:"operators"`
		Groups    []any            `json:"groups"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	out := &api.OperatorTypeList{Groups: raw.Groups, Operators: []api.OperatorType{}}
	if out.Groups == nil {
		out.Groups = []any{}
	}
	for _, op := range raw.Operators {
		t := api.OperatorType{InputPorts: []any{}, OutputPorts: []any{}}
		t.OperatorType, _ = op["operatorType"].(string)
		t.JsonSchema = op["jsonSchema"]
		meta := op
		if am, ok := op["additionalMetadata"].(map[string]any); ok {
			meta = am
		}
		t.UserFriendlyName, _ = meta["userFriendlyName"].(string)
		t.OperatorGroupName, _ = meta["operatorGroupName"].(string)
		if d, ok := meta["operatorDescription"].(string); ok {
			t.OperatorDescription = &d
		}
		if ip, ok := meta["inputPorts"].([]any); ok {
			t.InputPorts = ip
		}
		if opts, ok := meta["outputPorts"].([]any); ok {
			t.OutputPorts = opts
		}
		if v, ok := op["operatorVersion"].(string); ok {
			t.Version = &v
		} else if v, ok := op["version"].(string); ok {
			t.Version = &v
		}
		if t.UserFriendlyName == "" {
			t.UserFriendlyName = t.OperatorType
		}
		out.Operators = append(out.Operators, t)
	}
	return out, nil
}

var _ = store.ErrNotFound
