package server

import (
	"net/http"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
)

// routeCompute registers the computing unit and environment actions.
func (s *Server) routeCompute() {
	units := Prefix + "/computing-units"
	s.handle("GET "+units+"/available", func(w http.ResponseWriter, r *http.Request) error {
		rs, err := s.svc.Available(ctxOf(r), callerOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, envelopes(rs))
		return nil
	})
	s.handle("POST "+units+"/{rid}/terminate", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		unit, err := s.svc.Terminate(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(unit))
		return nil
	})
	s.handle("GET "+units+"/{rid}/computing-nodes", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		nodes, err := s.svc.Nodes(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, nodes)
		return nil
	})
	s.handle("GET "+units+"/{rid}/computing-nodes/{name}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		nodes, err := s.svc.Nodes(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		for _, n := range nodes {
			if n.Name == r.PathValue("name") {
				writeJSON(w, http.StatusOK, n)
				return nil
			}
		}
		return catalog.NotFound("computing node " + r.PathValue("name"))
	})
	s.handle("GET "+units+"/{rid}/operators", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		list, err := s.svc.UnitOperators(ctxOf(r), callerOf(r), rid, r.URL.Query().Get("q"), r.URL.Query().Get("group"))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, list)
		return nil
	})

	s.handle("POST "+Prefix+"/environments/{rid}/build", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.BuildEnvironment
		if err := decode(r, &body); err != nil {
			return err
		}
		vno := 0
		if body.Vno != nil {
			vno = int(*body.Vno)
		}
		build, err := s.svc.BuildEnvironment(ctxOf(r), callerOf(r), rid, vno, uriString(body.ComputingUnit))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusAccepted, build)
		return nil
	})
}
