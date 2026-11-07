package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

type resourceLike = *store.Resource

// routeResources registers the generic routes: search across kinds, resolve a URI, and the
// versions, lineage, dependents and grants every kind shares.
func (s *Server) routeResources() {
	base := Prefix + "/resources"
	s.handle("GET "+base, func(w http.ResponseWriter, r *http.Request) error {
		f, err := listFilter(r)
		if err != nil {
			return err
		}
		if f.Origin, err = queryRid(r, "origin"); err != nil {
			return err
		}
		f.Shared = r.URL.Query().Get("shared") == "true"
		var kind *kinds.Kind
		if name := r.URL.Query().Get("kind"); name != "" {
			k, ok := kinds.ByName(name)
			if !ok {
				return catalog.Invalid("unknown kind "+name, nil)
			}
			kind = &k
		}
		p, err := s.svc.List(ctxOf(r), callerOf(r), kind, f)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, s.page(ctxOf(r), p.Items, p.NextCursor))
		return nil
	})
	s.handle("GET "+base+"/resolve", func(w http.ResponseWriter, r *http.Request) error {
		name := r.URL.Query().Get("uri")
		if name == "" {
			return catalog.Invalid("uri is required", nil)
		}
		res, err := s.svc.Resolve(ctxOf(r), callerOf(r), name)
		if err != nil {
			return err
		}
		out := api.Resolved{Resource: catalog.Envelope(res.Resource)}
		if res.Version != nil {
			v := catalog.VersionOf(res.Resource, res.Version)
			out.Version = &v
		}
		if res.Subresource != "" {
			out.Subresource = &res.Subresource
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+base+"/{rid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		res, err := s.svc.Get(ctxOf(r), callerOf(r), nil, rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res))
		return nil
	})
	s.handle("GET "+base+"/{rid}/events", s.watch)
	s.handle("PATCH "+base+"/{rid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.UpdateMetadata
		if err := decode(r, &body); err != nil {
			return err
		}
		in := catalog.MetadataInput{RID: rid, Name: body.Name, Description: body.Description, IfMatch: r.Header.Get("If-Match")}
		if body.Visibility != nil {
			v := string(*body.Visibility)
			in.Visibility = &v
		}
		if body.Labels != nil {
			in.Labels = *body.Labels
		}
		if body.Parent != nil {
			parent, err := uuid.Parse(string(*body.Parent))
			if err != nil {
				return catalog.Invalid("parent is not a resource id", nil)
			}
			in.Parent = &parent
		}
		res, err := s.svc.UpdateMetadata(ctxOf(r), callerOf(r), in)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.Envelope(res))
		return nil
	})
	s.handle("DELETE "+base+"/{rid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		if err := s.svc.Delete(ctxOf(r), callerOf(r), nil, rid); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	s.handle("GET "+base+"/{rid}/versions", s.listVersions(nil))
	s.handle("GET "+base+"/{rid}/versions/{vno}", s.getVersion(nil))
	s.handle("GET "+base+"/{rid}/lineage", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		root, edges, err := s.svc.Lineage(ctxOf(r), callerOf(r), rid, queryInt(r, "vno", 0), r.URL.Query().Get("direction"), queryInt(r, "depth", 4))
		if err != nil {
			return err
		}
		out := api.LineageGraph{Root: api.Uri(root), Edges: make([]api.Edge, 0, len(edges))}
		for _, e := range edges {
			out.Edges = append(out.Edges, catalog.EdgeOf(e))
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+base+"/{rid}/dependents", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		edges, err := s.svc.Dependents(ctxOf(r), callerOf(r), rid, queryInt(r, "vno", 0))
		if err != nil {
			return err
		}
		out := make([]api.Edge, 0, len(edges))
		for _, e := range edges {
			out = append(out, catalog.EdgeOf(e))
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+base+"/{rid}/grants", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		grants, err := s.svc.Grants(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		out := make([]api.Grant, 0, len(grants))
		for _, g := range grants {
			out = append(out, catalog.GrantOf(g))
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("GET "+base+"/{rid}/needs", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		principal, err := queryRid(r, "principal")
		if err != nil {
			return err
		}
		if principal == nil {
			return catalog.Invalid("principal is required", nil)
		}
		needed, err := s.svc.Needs(ctxOf(r), callerOf(r), rid, *principal)
		if err != nil {
			return err
		}
		out := make([]api.Needed, 0, len(needed))
		for i := range needed {
			out = append(out, api.Needed{Resource: catalog.Envelope(&needed[i].Resource), Shareable: needed[i].Shareable})
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("PUT "+base+"/{rid}/grants/{pid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		pid, err := ridParam(r, "pid")
		if err != nil {
			return err
		}
		var body api.GrantRequest
		if err := decode(r, &body); err != nil {
			return err
		}
		g, err := s.svc.Grant(ctxOf(r), callerOf(r), rid, pid, string(body.Relation))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, catalog.GrantOf(*g))
		return nil
	})
	s.handle("DELETE "+base+"/{rid}/grants/{pid}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		pid, err := ridParam(r, "pid")
		if err != nil {
			return err
		}
		if err := s.svc.Revoke(ctxOf(r), callerOf(r), rid, pid); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})

	// Executions across workflows.
	s.handle("GET "+Prefix+"/executions", func(w http.ResponseWriter, r *http.Request) error {
		f, err := listFilter(r)
		if err != nil {
			return err
		}
		if f.Parent, err = queryRid(r, "workflow"); err != nil {
			return err
		}
		if f.Origin, err = queryRid(r, "conversation"); err != nil {
			return err
		}
		f.Fields = map[string]string{}
		if phase := r.URL.Query().Get("phase"); phase != "" {
			f.Fields["/status/phase"] = phase
		}
		if unit := r.URL.Query().Get("computingUnit"); unit != "" {
			rid, err := uuid.Parse(unit)
			if err != nil {
				return catalog.Invalid("computingUnit is not a resource id", nil)
			}
			f.Fields["/spec/computingUnit"] = "texera://computing-units/" + rid.String()
		}
		k, _ := kinds.ByName("execution")
		p, err := s.svc.List(ctxOf(r), callerOf(r), &k, f)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, s.page(ctxOf(r), p.Items, p.NextCursor))
		return nil
	})

	// The live document of a resource, kept for the live service between sessions.
	s.handle("GET "+Prefix+"/resources/{rid}/live", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		l, err := s.svc.LiveState(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		out := api.LiveState{State: l.State}
		if l.BasedOn != nil {
			vno := api.Vno(*l.BasedOn)
			out.BasedOn = &vno
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("PUT "+Prefix+"/resources/{rid}/live", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.LiveState
		if err := decode(r, &body); err != nil {
			return err
		}
		var basedOn *int
		if body.BasedOn != nil {
			n := int(*body.BasedOn)
			basedOn = &n
		}
		if err := s.svc.KeepLiveState(ctxOf(r), callerOf(r), rid, basedOn, body.State); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})

	// OpenLineage events from units and other producers.
	s.handle("POST /lineage/v1/events", func(w http.ResponseWriter, r *http.Request) error {
		var ev api.LineageEvent
		if err := decode(r, &ev); err != nil {
			return err
		}
		if err := s.svc.Ingest(ctxOf(r), callerOf(r), ev); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})

	// AuthZEN evaluation.
	s.handle("POST /access/v1/evaluation", func(w http.ResponseWriter, r *http.Request) error {
		var req api.AuthzRequest
		if err := decode(r, &req); err != nil {
			return err
		}
		caller := callerOf(r)
		if req.Subject.Id != "" && req.Subject.Id != caller.PID().String() && !caller.Service && !caller.Admin() {
			return catalog.Forbidden()
		}
		rid, err := uuid.Parse(req.Resource.Id)
		if err != nil {
			return catalog.Invalid("resource.id must be a resource id", nil)
		}
		subject := caller
		if req.Subject.Id != "" && req.Subject.Id != caller.PID().String() {
			pid, err := uuid.Parse(req.Subject.Id)
			if err != nil {
				return catalog.Invalid("subject.id must be a principal id", nil)
			}
			p, err := s.svc.Principal(ctxOf(r), pid)
			if err != nil {
				return err
			}
			subject = &auth.Caller{Principal: p}
		}
		allowed, err := s.pdp.Allowed(ctxOf(r), subject, req.Action.Name, rid)
		if err != nil {
			return catalog.Invalid(err.Error(), nil)
		}
		writeJSON(w, http.StatusOK, api.AuthzResponse{Decision: allowed})
		return nil
	})
}

// watch streams a resource's changes as server-sent events. Whether the caller may read it is
// settled before the first byte, so a refusal is an ordinary JSON error; after that the
// stream runs until the client goes away, the resource is deleted or the right to read it is.
func (s *Server) watch(w http.ResponseWriter, r *http.Request) error {
	rid, err := ridParam(r, "rid")
	if err != nil {
		return err
	}
	if _, err := s.svc.Get(ctxOf(r), callerOf(r), nil, rid); err != nil {
		return err
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("the response cannot stream")
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	send := func(event string, data any) error {
		if event == "" {
			_, err := io.WriteString(w, ": keepalive\n\n")
			flusher.Flush()
			return err
		}
		raw, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if err := s.svc.Watch(ctxOf(r), callerOf(r), rid, int64(queryInt(r, "after", 0)), send); err != nil {
		s.log.Debug("watch ended", "rid", rid, "err", err)
	}
	return nil
}
