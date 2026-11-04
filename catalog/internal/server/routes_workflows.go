package server

import (
	"encoding/json"
	"net/http"

	jsonpatch "github.com/evanphx/json-patch/v5"
	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
)

// routeWorkflows registers the workflow actions and the executions nested under a workflow.
func (s *Server) routeWorkflows() {
	wf, _ := kinds.ByName("workflow")
	base := Prefix + "/workflows/{rid}"

	s.handle("POST "+base+"/edit", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.EditWorkflow
		if err := decode(r, &body); err != nil {
			return err
		}
		var spec json.RawMessage
		switch {
		case body.Spec != nil:
			spec = mustJSON(body.Spec)
		case body.Patch != nil && len(*body.Patch) > 0:
			res, err := s.svc.Get(ctxOf(r), callerOf(r), &wf, rid)
			if err != nil {
				return err
			}
			patch, err := jsonpatch.DecodePatch(mustJSON(body.Patch))
			if err != nil {
				return catalog.Invalid("bad patch: "+err.Error(), nil)
			}
			spec, err = patch.Apply(res.Spec)
			if err != nil {
				return catalog.Invalid("the patch does not apply: "+err.Error(), nil)
			}
			if body.ExpectedHead == nil {
				head := int(res.HeadVno)
				expected := api.Vno(head)
				body.ExpectedHead = &expected
			}
		default:
			return catalog.Invalid("give a patch or a spec", nil)
		}
		var expected *int
		if body.ExpectedHead != nil {
			n := int(*body.ExpectedHead)
			expected = &n
		}
		res, v, err := s.svc.UpdateSpec(ctxOf(r), callerOf(r), wf, catalog.UpdateSpecInput{RID: rid, Spec: spec, Message: body.Message, ExpectedHead: expected})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.VersionOf(res, v))
		return nil
	})

	s.handle("POST "+base+"/validate", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.ValidateWorkflow
		if err := decode(r, &body); err != nil {
			return err
		}
		vno := 0
		if body.Vno != nil {
			vno = int(*body.Vno)
		}
		result, err := s.svc.Validate(ctxOf(r), callerOf(r), rid, vno, body.Spec, uriString(body.ComputingUnit))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, result)
		return nil
	})

	s.handle("POST "+base+"/run", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.RunWorkflow
		if err := decode(r, &body); err != nil {
			return err
		}
		in := catalog.RunInput{ComputingUnit: uriString(body.ComputingUnit), Environment: uriString(body.Environment)}
		if body.Vno != nil {
			in.Vno = int(*body.Vno)
		}
		if body.WaitSeconds != nil {
			in.WaitSeconds = int(*body.WaitSeconds)
		}
		if body.Name != nil {
			in.Name = *body.Name
		}
		if body.Parameters != nil {
			in.Parameters = *body.Parameters
		}
		exec, err := s.svc.Run(ctxOf(r), callerOf(r), rid, in)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, catalog.Envelope(exec))
		return nil
	})

	s.handle("GET "+base+"/executions", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		if _, err := s.svc.Get(ctxOf(r), callerOf(r), &wf, rid); err != nil {
			return err
		}
		f, err := listFilter(r)
		if err != nil {
			return err
		}
		f.Parent = &rid
		if phase := r.URL.Query().Get("phase"); phase != "" {
			f.Fields = map[string]string{"/status/phase": phase}
		}
		k, _ := kinds.ByName("execution")
		p, err := s.svc.List(ctxOf(r), callerOf(r), &k, f)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, page(p.Items, p.NextCursor))
		return nil
	})

	s.handle("GET "+base+"/executions/{eid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		exec, err := s.svc.Execution(ctxOf(r), callerOf(r), rid, eid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(exec))
		return nil
	})

	s.handle("DELETE "+base+"/executions/{eid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		if err := s.svc.DeleteExecution(ctxOf(r), callerOf(r), rid, eid); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})

	s.handle("POST "+base+"/executions/{eid}/cancel", func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		exec, err := s.svc.Cancel(ctxOf(r), callerOf(r), rid, eid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(exec))
		return nil
	})

	port := base + "/executions/{eid}/operators/{operatorID}/ports/{portID}"
	s.handle("GET "+port, func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		out, err := s.svc.Port(ctxOf(r), callerOf(r), rid, eid, r.PathValue("operatorID"), r.PathValue("portID"))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})

	s.handle("GET "+port+"/rows", func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		rows, err := s.svc.Rows(ctxOf(r), callerOf(r), rid, eid, r.PathValue("operatorID"), r.PathValue("portID"), int64(queryInt(r, "offset", 0)), int32(queryInt(r, "limit", 100)))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, rows)
		return nil
	})

	s.handle("POST "+port+"/save", func(w http.ResponseWriter, r *http.Request) error {
		rid, eid, err := workflowAndExecution(r)
		if err != nil {
			return err
		}
		var body api.SavePort
		if err := decode(r, &body); err != nil {
			return err
		}
		in := catalog.SavePortInput{Message: body.Message}
		if body.Name != nil {
			in.Name = *body.Name
		}
		if body.Path != nil {
			in.Path = *body.Path
		}
		if body.Dataset != nil {
			ds, err := uuid.Parse(string(*body.Dataset))
			if err != nil {
				return catalog.Invalid("dataset is not a resource id", nil)
			}
			in.Dataset = &ds
		}
		ds, v, err := s.svc.SavePort(ctxOf(r), callerOf(r), rid, eid, r.PathValue("operatorID"), r.PathValue("portID"), in)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, catalog.VersionOf(ds, v))
		return nil
	})
}

func workflowAndExecution(r *http.Request) (uuid.UUID, uuid.UUID, error) {
	rid, err := ridParam(r, "rid")
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	eid, err := ridParam(r, "eid")
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return rid, eid, nil
}

func uriString(u *api.Uri) string {
	if u == nil {
		return ""
	}
	return string(*u)
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
