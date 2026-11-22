package catalog

// Saving a result: an execution's results are dropped with it or by the retention policy, so
// a person, or the agent for them, saves the rows of one output port as the next version of a
// dataset, one CSV file. The version derives from the port, which the lineage records in the
// version's own transaction; the execution then stays while the version does.

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// savedPage is how many rows a saved result is read in at a time.
const savedPage = 1000

// SaveResult saves an output port's rows of a completed execution as the next version of a
// dataset: one the caller may write, or a new one of the execution's project.
func (s *Service) SaveResult(ctx context.Context, caller *auth.Caller, workflowRID, eid uuid.UUID, operatorID, portID string, in api.SaveResult) (*store.Resource, *store.Version, error) {
	exec, err := s.Execution(ctx, caller, workflowRID, eid)
	if err != nil {
		return nil, nil, err
	}
	var st api.ExecutionStatus
	_ = json.Unmarshal(exec.Status, &st)
	if st.Phase != api.ExecutionPhaseCompleted {
		return nil, nil, Conflict("not_completed", fmt.Sprintf("%s is %s: only a completed execution's results are saved", exec.Name, st.Phase), nil)
	}
	if at := resultsExpired(exec); at != nil {
		return nil, nil, Gone("the execution's results", *at)
	}
	table := plannedTable(exec, operatorID, portID)
	if table == "" {
		return nil, nil, NotFound(fmt.Sprintf("the result of %s/%s", operatorID, portID))
	}
	path := operatorID + ".csv"
	if in.Path != nil {
		if path, err = cleanPath(*in.Path); err != nil {
			return nil, nil, err
		}
	}
	// Where it goes is settled before a row is read: a dataset the caller may write, or the
	// right to make one in the execution's project.
	var dataset *store.Resource
	if in.Dataset != nil {
		if dataset, err = s.resourceByURI(ctx, caller, string(*in.Dataset), &datasetKind); err != nil {
			return nil, nil, err
		}
		if err := s.require(ctx, caller, authz.Write, dataset.RID); err != nil {
			return nil, nil, err
		}
	} else if exec.ProjectRID == nil {
		return nil, nil, Invalid(exec.Name+" is in no project: name a dataset to save its result in", nil)
	} else if err := s.require(ctx, caller, authz.Write, *exec.ProjectRID); err != nil {
		return nil, nil, err
	}
	file, err := s.resultFile(ctx, caller, exec, operatorID, portID, table, path)
	if err != nil {
		return nil, nil, err
	}
	if dataset == nil {
		name := strings.TrimSpace(deref(in.Name))
		if name == "" {
			name = operatorName(s.ranWorkflow(ctx, exec), operatorID) + " of " + exec.Name
		}
		if dataset, _, err = s.Create(ctx, caller, CreateInput{Kind: datasetKind, Name: name, Description: in.Description, Parent: exec.ProjectRID, Spec: json.RawMessage(`{"format":"csv"}`)}); err != nil {
			return nil, nil, err
		}
	}
	port := URI(exec).With("operators", operatorID, "ports", portID).String()
	message := fmt.Sprintf("saved from %s/%s of %s", operatorID, portID, exec.Name)
	into := dataset
	r, v, err := s.filesVersion(ctx, caller, datasetKind, dataset, nextFiles{
		files: []api.DatasetFile{*file}, message: &message,
		lineage: func(vno int) []store.Edge {
			return []store.Edge{{From: URI(into).WithVersion(vno).With("files", path).String(), Relation: "derivedFrom", To: port, FromRID: into.RID, ToRID: &exec.RID, ExecutionRID: &exec.RID}}
		},
	})
	if err != nil {
		// A dataset made for the result holds nothing without it.
		if in.Dataset == nil {
			_ = s.Store.DeleteResource(ctx, dataset.RID)
		}
		return nil, nil, err
	}
	return r, v, nil
}

// resultFile writes a port's rows as a CSV file, its header the result's columns, into the
// blob store at the path given.
func (s *Service) resultFile(ctx context.Context, caller *auth.Caller, exec *store.Resource, operatorID, portID, table, path string) (*api.DatasetFile, error) {
	client, err := s.resultsUnit(ctx, caller, exec)
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp("", "texera-result-*.csv")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	w := csv.NewWriter(tmp)
	header := false
	for offset := int64(0); ; {
		page, err := client.Result(ctx, exec.RID.String(), operatorID, portID, table, executionNamespace(exec.RID), s.warehouseOf(ctx, exec), offset, savedPage)
		if err != nil {
			return nil, UnitFailed(err)
		}
		if !header {
			names := make([]string, len(page.Schema))
			for i, a := range page.Schema {
				names[i] = a.AttributeName
			}
			if err := w.Write(names); err != nil {
				return nil, err
			}
			header = true
		}
		for _, row := range page.Rows {
			cells := make([]string, len(row))
			for i, c := range row {
				cells[i] = cellText(c)
			}
			if err := w.Write(cells); err != nil {
				return nil, err
			}
		}
		offset += int64(len(page.Rows))
		if len(page.Rows) == 0 || (page.Total != nil && offset >= *page.Total) {
			break
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		return nil, err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return s.putFile(ctx, path, tmp, "text/csv")
}

// cellText is a cell as a CSV file holds it: text as it is, a missing value empty, anything
// else as JSON writes it.
func cellText(c any) string {
	switch v := c.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	default:
		b, _ := json.Marshal(v)
		return string(b)
	}
}

// operatorName is how a person knows an operator of a workflow version: the name they gave
// it, else its ID.
func operatorName(spec *api.WorkflowSpec, operatorID string) string {
	if op := operatorOf(spec, "operators/"+operatorID); op != nil && op.CustomDisplayName != nil && strings.TrimSpace(*op.CustomDisplayName) != "" {
		return strings.TrimSpace(*op.CustomDisplayName)
	}
	return operatorID
}
