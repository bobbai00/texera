package server

import (
	"encoding/json"
	"net/http"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
)

func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }

// routeIAM registers me, principals, a project's settings, the public page and the retention sweep.
func (s *Server) routeIAM() {
	s.handle("GET "+Prefix+"/me", func(w http.ResponseWriter, r *http.Request) error {
		me, err := s.svc.Me(ctxOf(r), callerOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, me)
		return nil
	})
	s.handle("PUT "+Prefix+"/me/preferences", func(w http.ResponseWriter, r *http.Request) error {
		var prefs json.RawMessage
		if err := decode(r, &prefs); err != nil {
			return err
		}
		out, err := s.svc.UpdatePreferences(ctxOf(r), callerOf(r), prefs)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+Prefix+"/principals", func(w http.ResponseWriter, r *http.Request) error {
		ps, err := s.svc.Principals(ctxOf(r), r.URL.Query().Get("q"), r.URL.Query().Get("kind"), queryInt(r, "limit", 50))
		if err != nil {
			return err
		}
		out := api.PrincipalPage{Items: make([]api.Principal, 0, len(ps))}
		for i := range ps {
			out.Items = append(out.Items, catalog.PrincipalOf(&ps[i]))
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+Prefix+"/principals/{pid}", func(w http.ResponseWriter, r *http.Request) error {
		pid, err := ridParam(r, "pid")
		if err != nil {
			return err
		}
		p, err := s.svc.Principal(ctxOf(r), pid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.PrincipalOf(p))
		return nil
	})
	s.handle("POST "+Prefix+"/retention/sweep", func(w http.ResponseWriter, r *http.Request) error {
		out, err := s.svc.Sweep(ctxOf(r), callerOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+Prefix+"/public", func(w http.ResponseWriter, r *http.Request) error {
		out, err := s.svc.Public(ctxOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+Prefix+"/projects/{rid}/inheritors", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		out, err := s.svc.Inheritors(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+Prefix+"/projects/{rid}/settings", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		out, err := s.svc.ProjectSettings(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
}
