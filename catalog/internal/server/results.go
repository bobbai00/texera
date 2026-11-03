package server

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

// maxSavedRows bounds a saved result; the catalog builds the file in memory.
const maxSavedRows = 1_000_000

// resultPageSize is the largest page the unit serves.
const resultPageSize = 1000

// ExecutionsSaveResult saves a port result as a new dataset version. The version's lineage records
// it as produced by the workflow version the execution ran, with the execution on the edge, so the
// chain reads dataset version <- workflow version <- the dataset versions the run read.
func (s *Server) ExecutionsSaveResult(ctx context.Context, req api.ExecutionsSaveResultRequestObject) (api.ExecutionsSaveResultResponseObject, error) {
	caller, err := callerOf(ctx)
	if err != nil {
		return nil, err
	}
	if req.Body == nil {
		return nil, badRequest("a body is required")
	}
	ex, err := s.loadExecution(ctx, caller, req.Eid, authz.ActionRead)
	if err != nil {
		return nil, err
	}
	if ex.Status != "completed" {
		return nil, conflict("only a completed execution's results can be saved")
	}
	data, err := s.resultCSV(ctx, ex, req.Opid, req.Port)
	if err != nil {
		return nil, err
	}

	var target *store.Resource
	if req.Body.Dataset != nil {
		if target, err = s.loadResource(ctx, caller, *req.Body.Dataset, "dataset", authz.ActionWrite); err != nil {
			return nil, err
		}
		// The commit takes everything staged; files someone staged by hand must not ride along.
		staged, err := s.store.ListStagedFiles(ctx, target.RID)
		if err != nil {
			return nil, err
		}
		if len(staged) > 0 {
			return nil, conflict("the dataset has staged files; commit or unstage them first")
		}
	} else {
		name := ""
		if req.Body.Name != nil {
			name = strings.TrimSpace(*req.Body.Name)
		}
		if name == "" {
			name = fmt.Sprintf("%s result", req.Opid)
		}
		description := fmt.Sprintf("Saved from %s/%s of execution %s.", req.Opid, req.Port, ex.EID)
		format := "csv"
		if _, target, err = createKind(ctx, s, datasetKind, createArgs[api.DatasetSpec]{
			Name: name, Description: &description, Spec: api.DatasetSpec{Format: &format},
		}); err != nil {
			return nil, err
		}
	}

	path := req.Opid + ".csv"
	if req.Body.Path != nil && strings.TrimSpace(*req.Body.Path) != "" {
		path = strings.TrimSpace(*req.Body.Path)
	}
	if _, err := s.stageFile(ctx, target, path, bytes.NewReader(data)); err != nil {
		return nil, err
	}
	message := req.Body.Message
	if message == nil {
		m := fmt.Sprintf("%s/%s of execution %s", req.Opid, req.Port, ex.EID)
		message = &m
	}
	v, err := s.commitStaged(ctx, caller, target, message, nil)
	if err != nil {
		return nil, err
	}
	eid := ex.EID
	if err := s.store.AddVersionEdge(ctx, store.VersionEdge{
		From: store.VersionRef{RID: ex.WorkflowRID, Vno: ex.WorkflowVno},
		To:   store.VersionRef{RID: target.RID, Vno: v.Vno},
		Kind: "produced", EID: &eid,
	}); err != nil {
		return nil, err
	}
	return api.ExecutionsSaveResult200JSONResponse(toVersion(v, target.Kind)), nil
}

// resultCSV reads a whole port result from the execution's unit and renders it as CSV with a
// header row.
func (s *Server) resultCSV(ctx context.Context, ex *store.Execution, opid, port string) ([]byte, error) {
	unitRes, err := s.store.GetResource(ctx, ex.CuRID)
	if err != nil {
		return nil, notFound("the execution's unit")
	}
	unit, err := s.unitFor(ctx, unitRes)
	if err != nil {
		return nil, err
	}
	table := s.recordedTable(ctx, ex.EID, opid, port)
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	var offset int64
	for first := true; ; first = false {
		page, err := unit.Result(ctx, ex.EID.String(), opid, port, table, offset, resultPageSize)
		if err != nil {
			return nil, err
		}
		if first {
			header := make([]string, len(page.Schema))
			for i, a := range page.Schema {
				header[i] = a.AttributeName
			}
			if err := w.Write(header); err != nil {
				return nil, err
			}
		}
		for _, row := range page.Rows {
			record := make([]string, len(row))
			for i, cell := range row {
				record[i] = csvCell(cell)
			}
			if err := w.Write(record); err != nil {
				return nil, err
			}
		}
		offset += int64(len(page.Rows))
		if len(page.Rows) == 0 || (page.Total != nil && offset >= *page.Total) {
			break
		}
		if offset >= maxSavedRows {
			return nil, badRequest("the result has more than %d rows; save a smaller result", maxSavedRows)
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// csvCell renders one result cell: text as is, numbers exactly, null as an empty cell, anything
// structured as JSON.
func csvCell(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		b, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(b)
	}
}
