package server

import (
	"net/http"
	"strconv"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/store"
)

// routeAgents registers the conversation subresources (messages, turns, what the chat
// produced) and the credential actions (secret, lease).
func (s *Server) routeAgents() {
	conv := Prefix + "/conversations/{rid}"
	s.handle("GET "+conv+"/messages", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		msgs, next, err := s.svc.Messages(ctxOf(r), callerOf(r), rid, int64(queryInt(r, "after", 0)), queryInt(r, "limit", 200))
		if err != nil {
			return err
		}
		out := api.MessagePage{Items: make([]api.Message, 0, len(msgs))}
		for i := range msgs {
			out.Items = append(out.Items, messageOf(&msgs[i]))
		}
		if next != "" {
			out.NextCursor = &next
		}
		writeJSON(w, http.StatusOK, out)
		return nil
	})
	s.handle("POST "+conv+"/messages", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.AppendMessage
		if err := decode(r, &body); err != nil {
			return err
		}
		m, err := s.svc.Append(ctxOf(r), callerOf(r), rid, body)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, messageOf(m))
		return nil
	})
	s.handle("PUT "+conv+"/messages/{seq}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
		if err != nil {
			return catalog.Invalid("seq must be an integer", nil)
		}
		var body api.ReplaceMessage
		if err := decode(r, &body); err != nil {
			return err
		}
		m, err := s.svc.Replace(ctxOf(r), callerOf(r), rid, seq, body)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, messageOf(m))
		return nil
	})
	s.handle("POST "+conv+"/turns", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.StartTurn
		if err := decode(r, &body); err != nil {
			return err
		}
		turn, err := s.svc.StartTurn(ctxOf(r), callerOf(r), rid, uriString(body.Template))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, turn)
		return nil
	})
	s.handle("DELETE "+conv+"/turns/{turn}", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		if err := s.svc.EndTurn(ctxOf(r), callerOf(r), rid, r.PathValue("turn")); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	s.handle("GET "+conv+"/resources", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		rs, err := s.svc.ConversationResources(ctxOf(r), callerOf(r), rid)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, envelopes(rs))
		return nil
	})

	cred := Prefix + "/credentials/{rid}"
	s.handle("PUT "+cred+"/secret", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.SetSecret
		if err := decode(r, &body); err != nil {
			return err
		}
		if err := s.svc.SetSecret(ctxOf(r), callerOf(r), rid, body.Fields); err != nil {
			return err
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	})
	s.handle("POST "+cred+"/lease", func(w http.ResponseWriter, r *http.Request) error {
		rid, err := ridParam(r, "rid")
		if err != nil {
			return err
		}
		var body api.LeaseRequest
		if err := decode(r, &body); err != nil {
			return err
		}
		lease, err := s.svc.Lease(ctxOf(r), callerOf(r), rid, string(body.Purpose))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusCreated, lease)
		return nil
	})
}

func messageOf(m *store.Message) api.Message { return catalog.MessageOf(m) }
