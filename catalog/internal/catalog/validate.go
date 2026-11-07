package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
)

// Validate compiles a workflow version or a draft spec on a unit: output schemas per port
// and errors per operator.
func (s *Service) Validate(ctx context.Context, caller *auth.Caller, workflowRID uuid.UUID, vno int, draft *api.WorkflowSpec, unitName string) (*api.WorkflowValidation, error) {
	wf, err := s.Get(ctx, caller, &workflowKind, workflowRID)
	if err != nil {
		return nil, err
	}
	var spec api.WorkflowSpec
	if draft != nil {
		spec = *draft
	} else {
		version, err := s.Store.GetVersion(ctx, wf.RID, vno)
		if err != nil {
			return nil, NotFound(fmt.Sprintf("version %d of %s", vno, wf.Name))
		}
		if err := json.Unmarshal(version.Content, &spec); err != nil {
			return nil, Invalid("the workflow version is not a workflow spec", nil)
		}
	}
	unitName = firstNonEmpty(unitName, uriString(spec.DefaultComputingUnit), uriString(s.defaultsOf(ctx, wf.ProjectRID).ComputingUnit))
	if unitName == "" {
		return nil, Conflict("no_unit", "no computing unit to compile on", nil)
	}
	unit, err := s.named(ctx, unitName, unitKind)
	if err != nil {
		return nil, err
	}
	// The same compile and the same authorization as an execution; the engine then compiles the
	// bound copy, with the credentials left as URIs.
	c, err := s.compile(ctx, spec, wf.ProjectRID)
	if err != nil {
		return nil, err
	}
	if err := s.authorizePlan(ctx, caller, c, unit, nil); err != nil {
		return nil, err
	}
	client, status, err := s.unitClient(ctx, unit)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, Conflict("unit_not_ready", "the unit is "+string(status.Phase), nil)
	}
	bound, _, err := s.bindInputs(ctx, caller, c)
	if err != nil {
		return nil, err
	}
	result, err := client.Compile(ctx, bound)
	if err != nil {
		return nil, UnitFailed(err)
	}
	var out api.WorkflowValidation
	if err := json.Unmarshal(mustJSON(result), &out); err != nil {
		return nil, err
	}
	plan := c.apiPlan("")
	out.Plan = &plan
	return &out, nil
}
