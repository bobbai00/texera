package server

import (
	"net/http"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
)

// routeCompute registers the computing unit actions: making one from a profile, saving one as a
// profile, and its lifecycle.
func (s *Server) routeCompute() {
	units := Prefix + "/computing-units"
	s.handle("GET "+units+"/available", func(w http.ResponseWriter, r *http.Request) error {
		scope, err := queryRid(r, "scope")
		if err != nil {
			return err
		}
		rs, err := s.svc.Available(ctxOf(r), callerOf(r), scope)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, s.envelopes(ctxOf(r), rs))
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

	// A unit made from a profile, and a unit saved as one.
	s.handle("POST "+units+"/from-profile", func(w http.ResponseWriter, r *http.Request) error {
		var body api.ComputingUnitFromProfile
		if err := decode(r, &body); err != nil {
			return err
		}
		unit, err := s.svc.UnitFromProfile(ctxOf(r), callerOf(r), body)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, catalog.Envelope(unit))
		return nil
	})
	s.handle("POST "+units+"/{rid}/profile", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.SaveUnitAsProfile
		if err := decode(r, &body); err != nil {
			return err
		}
		profile, err := s.svc.SaveUnitAsProfile(ctxOf(r), callerOf(r), rid, body)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(profile))
		return nil
	})
}
