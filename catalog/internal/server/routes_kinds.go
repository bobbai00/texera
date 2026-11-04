package server

import (
	"encoding/json"
	"net/http"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
)

// routeKinds registers the standard methods of every top-level kind from the kind table:
// list, create, read, update, delete, and the versions of a versioned kind. Adding a kind to
// the contract adds its routes here without code.
func (s *Server) routeKinds() {
	for _, k := range kinds.Table {
		if k.Nested || k.Singleton {
			continue
		}
		k := k
		base := Prefix + "/" + k.Plural
		s.handle("GET "+base, s.listKind(k))
		s.handle("POST "+base, s.createKind(k))
		s.handle("GET "+base+"/{rid}", s.getKind(k))
		s.handle("PUT "+base+"/{rid}", s.updateKind(k))
		s.handle("DELETE "+base+"/{rid}", s.deleteKind(k))
		if k.Versioned {
			s.handle("GET "+base+"/{rid}/versions", s.listVersions(&k))
			s.handle("GET "+base+"/{rid}/versions/{vno}", s.getVersion(&k))
		}
	}
}

type createBody struct {
	Name        string            `json:"name"`
	Description *string           `json:"description"`
	Parent      *string           `json:"parent"`
	Visibility  *string           `json:"visibility"`
	Labels      map[string]string `json:"labels"`
	Spec        json.RawMessage   `json:"spec"`
	Message     *string           `json:"message"`
}

type updateBody struct {
	Spec         json.RawMessage `json:"spec"`
	Message      *string         `json:"message"`
	ExpectedHead *int            `json:"expectedHead"`
}

func (s *Server) listKind(k kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		f, err := listFilter(r)
		if err != nil {
			return err
		}
		if k.Name == "operator" {
			if group := r.URL.Query().Get("group"); group != "" {
				f.Fields = map[string]string{"/spec/group": group}
			}
		}
		p, err := s.svc.List(ctxOf(r), callerOf(r), &k, f)
		if err != nil {
			return err
		}
		items := envelopes(p.Items)
		if k.Name == "operator" && r.URL.Query().Get("view") != "full" && r.URL.Query().Get("q") == "" && r.URL.Query().Get("group") == "" {
			for i := range items {
				delete(items[i].Spec, "propertiesSchema")
				delete(items[i].Spec, "inputPorts")
				delete(items[i].Spec, "outputPorts")
				delete(items[i].Spec, "implementation")
			}
		}
		out := api.ResourcePage{Items: items}
		if p.NextCursor != "" {
			out.NextCursor = &p.NextCursor
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	}
}

func listFilter(r *http.Request) (catalog.ListFilter, error) {
	q := r.URL.Query()
	f := catalog.ListFilter{Query: q.Get("q"), Limit: queryInt(r, "limit", 50), Cursor: q.Get("cursor")}
	var err error
	if f.Parent, err = queryRid(r, "parent"); err != nil {
		return f, err
	}
	if f.Project, err = queryRid(r, "project"); err != nil {
		return f, err
	}
	return f, nil
}

func (s *Server) createKind(k kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		var body createBody
		if err := decode(r, &body); err != nil {
			return err
		}
		in := catalog.CreateInput{Kind: k, Name: body.Name, Description: body.Description, Labels: body.Labels, Spec: body.Spec, Message: body.Message}
		if body.Visibility != nil {
			in.Visibility = *body.Visibility
		}
		if body.Parent != nil && *body.Parent != "" {
			rid, err := uuid.Parse(*body.Parent)
			if err != nil {
				return catalog.Invalid("parent is not a resource id", nil)
			}
			in.Parent = &rid
		}
		res, _, err := s.svc.Create(ctxOf(r), callerOf(r), in)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, catalog.Envelope(res))
		return nil
	}
}

func (s *Server) getKind(k kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var res interface{}
		if k.Name == "computing-unit" {
			res, err = s.svc.Unit(ctxOf(r), callerOf(r), rid)
		} else {
			res, err = s.svc.Get(ctxOf(r), callerOf(r), &k, rid)
		}
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res.(resourceLike)))
		return nil
	}
}

func (s *Server) updateKind(k kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body updateBody
		if err := decode(r, &body); err != nil {
			return err
		}
		if len(body.Spec) == 0 {
			return catalog.Invalid("spec is required", nil)
		}
		res, _, err := s.svc.UpdateSpec(ctxOf(r), callerOf(r), k, catalog.UpdateSpecInput{RID: rid, Spec: body.Spec, Message: body.Message, ExpectedHead: body.ExpectedHead, IfMatch: r.Header.Get("If-Match")})
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res))
		return nil
	}
}

func (s *Server) deleteKind(k kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		if err := s.svc.Delete(ctxOf(r), callerOf(r), &k, rid); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
}

func (s *Server) listVersions(k *kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		res, vs, next, err := s.svc.Versions(ctxOf(r), callerOf(r), k, rid, queryInt(r, "limit", 50), r.URL.Query().Get("cursor"))
		if err != nil {
			return err
		}
		out := api.VersionSummaryPage{Items: make([]api.VersionSummary, 0, len(vs))}
		for i := range vs {
			out.Items = append(out.Items, catalog.SummaryOf(res, &vs[i]))
		}
		if next != "" {
			out.NextCursor = &next
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	}
}

func (s *Server) getVersion(k *kinds.Kind) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		vno, err := intParam(r, "vno")
		if err != nil {
			return err
		}
		res, v, err := s.svc.Version(ctxOf(r), callerOf(r), k, rid, vno)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.VersionOf(res, v))
		return nil
	}
}
