package catalog

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
)

// Validate compiles a workflow version or a draft spec on a unit: output schemas per port
// and errors per operator.
func (s *Service) Validate(ctx context.Context, caller *auth.Caller, workflowRID uuid.UUID, vno int, draft *api.WorkflowSpec, unitName string) (*api.CompileResult, error) {
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
	project := s.projectSpec(ctx, wf.ProjectRID)
	settings := s.settingsSpec(ctx)
	unitName = firstNonEmpty(unitName, uriString(spec.DefaultComputingUnit), uriString(project.DefaultComputingUnit), uriString(settings.Defaults.ComputingUnit))
	if unitName == "" {
		return nil, Conflict("no_unit", "no computing unit to compile on", nil)
	}
	unit, err := s.resourceByURI(ctx, caller, unitName, &unitKind)
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
	plan, err := s.buildPlan(ctx, caller, spec)
	if err != nil {
		return nil, err
	}
	result, err := client.Compile(ctx, plan.Plan)
	if err != nil {
		return nil, Unavailable("unit", err)
	}
	var out api.CompileResult
	if err := json.Unmarshal(mustJSON(result), &out); err != nil {
		return nil, err
	}
	return &out, nil
}
