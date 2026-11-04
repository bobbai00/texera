package server

import (
	"encoding/json"
	"net/http"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
)

func jsonUnmarshal(raw []byte, v any) error { return json.Unmarshal(raw, v) }

// routeIAM registers me, principals and settings.
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
	s.handle("GET "+Prefix+"/settings", func(w http.ResponseWriter, r *http.Request) error {
		res, err := s.svc.Settings(ctxOf(r), callerOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res))
		return nil
	})
	s.handle("PUT "+Prefix+"/settings", func(w http.ResponseWriter, r *http.Request) error {
		var body updateBody
		if err := decode(r, &body); err != nil {
			return err
		}
		res, err := s.svc.UpdateSettings(ctxOf(r), callerOf(r), body.Spec, r.Header.Get("If-Match"))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res))
		return nil
	})
	s.handle("GET "+Prefix+"/settings/public", func(w http.ResponseWriter, r *http.Request) error {
		out, err := s.svc.PublicSettings(ctxOf(r))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
}
