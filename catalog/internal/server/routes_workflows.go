package server

import (
	"context"
	"encoding/json"
	"net/http"

	jsonpatch "github.com/evanphx/json-patch/v5"
	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
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
			// A patch names operators by their place in the spec its writer read. When that is
			// not the head any more the workflow changed under them, and the patch is not tried
			// on a spec they never saw.
			head := api.Vno(res.HeadVno)
			if body.ExpectedHead != nil && *body.ExpectedHead != head {
				return catalog.Conflict("conflict", store.HeadMoved(int(head), int(*body.ExpectedHead)).Error(), nil)
			}
			spec, err = patch.Apply(res.Spec)
			if err != nil {
				return catalog.Invalid("the patch does not apply: "+err.Error(), nil)
			}
			// The patch was applied to this head: it is saved onto no other.
			body.ExpectedHead = &head
		default:
			return catalog.Invalid("give a patch or a spec", nil)
		}
		var expected *int
		if body.ExpectedHead != nil {
			n := int(*body.ExpectedHead)
			expected = &n
		}
		onBehalfOf, err := pids(body.OnBehalfOf)
		if err != nil {
			return err
		}
		res, v, err := s.svc.UpdateSpec(ctxOf(r), callerOf(r), wf, catalog.UpdateSpecInput{RID: rid, Spec: spec, Message: body.Message, ExpectedHead: expected, OnBehalfOf: onBehalfOf})
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

	for _, control := range []struct {
		verb string
		do   func(ctx context.Context, caller *auth.Caller, rid, eid uuid.UUID) (*store.Resource, error)
	}{{"pause", s.svc.Pause}, {"resume", s.svc.Resume}} {
		s.handle("POST "+base+"/executions/{eid}/"+control.verb, func(w http.ResponseWriter, r *http.Request) error {
			rid, eid, err := workflowAndExecution(r)
			if err != nil {
				return err
			}
			exec, err := control.do(ctxOf(r), callerOf(r), rid, eid)
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, catalog.Envelope(exec))
			return nil
		})
	}

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
