package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

var (
	conversationKind, _ = kinds.ByName("conversation")
	templateKind, _     = kinds.ByName("agent-template")
)

// Messages lists a conversation's messages after a seq.
func (s *Service) Messages(ctx context.Context, caller *auth.Caller, rid uuid.UUID, after int64, limit int) ([]store.Message, string, error) {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return nil, "", err
	}
	limit = pageSize(limit, 200, 500)
	msgs, err := s.Store.ListMessages(ctx, rid, after, limit+1)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(msgs) > limit {
		msgs = msgs[:limit]
		next = encodeCursor(int(msgs[len(msgs)-1].Seq))
	}
	return msgs, next, nil
}

// Append adds a message to a conversation.
func (s *Service) Append(ctx context.Context, caller *auth.Caller, rid uuid.UUID, in api.AppendMessage) (*store.Message, error) {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, rid); err != nil {
		return nil, err
	}
	// What wrote the message, each a URI of its kind.
	var template, modelEndpoint *string
	if in.Template != nil && *in.Template != "" {
		t := string(*in.Template)
		if err := kindOf(t, templateKind); err != nil {
			return nil, err
		}
		template = &t
	}
	if in.ModelEndpoint != nil && *in.ModelEndpoint != "" {
		e := string(*in.ModelEndpoint)
		if err := kindOf(e, modelEndpointKind); err != nil {
			return nil, err
		}
		modelEndpoint = &e
	}
	var servers []string
	if in.McpServers != nil {
		servers = make([]string, 0, len(*in.McpServers))
		for _, name := range *in.McpServers {
			if err := kindOf(string(name), mcpServerKind); err != nil {
				return nil, err
			}
			servers = append(servers, string(name))
		}
	}
	m, err := s.Store.AppendMessage(ctx, store.NewMessage{ConversationRID: rid, Turn: in.Turn, Role: string(in.Role), AuthorPID: caller.PID(),
		Template: template, ModelEndpoint: modelEndpoint, McpServers: servers, Parts: mustJSON(in.Parts)})
	if err != nil {
		return nil, wrap(err, "conversation")
	}
	if template != nil {
		s.recordTemplate(ctx, rid, *template)
	}
	return m, nil
}

// kindOf checks that a URI names a resource of a kind.
func kindOf(name string, kind kinds.Kind) error {
	ref, err := uri.Parse(name)
	if err != nil {
		return Invalid(err.Error(), nil)
	}
	if ref.Kind.Name != kind.Name {
		return Invalid(fmt.Sprintf("%s is not a %s", name, kind.Name), nil)
	}
	return nil
}

// recordTemplate adds a template version to the conversation's participants.
func (s *Service) recordTemplate(ctx context.Context, rid uuid.UUID, template string) {
	r, err := s.Store.GetResource(ctx, rid)
	if err != nil {
		return
	}
	var status api.ConversationStatus
	_ = json.Unmarshal(r.Status, &status)
	if status.Templates != nil {
		for _, t := range *status.Templates {
			if string(t) == template {
				return
			}
		}
	}
	templates := []api.Uri{}
	if status.Templates != nil {
		templates = *status.Templates
	}
	templates = append(templates, api.Uri(template))
	_, _ = s.Store.MergeStatus(ctx, rid, mustJSON(map[string]any{"templates": templates}))
}

// Replace rewrites the parts of a message a turn is still writing.
func (s *Service) Replace(ctx context.Context, caller *auth.Caller, rid uuid.UUID, seq int64, in api.ReplaceMessage) (*store.Message, error) {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, rid); err != nil {
		return nil, err
	}
	var template *string
	if in.Template != nil && *in.Template != "" {
		t := string(*in.Template)
		template = &t
	}
	m, err := s.Store.ReplaceMessage(ctx, rid, seq, mustJSON(in.Parts), template)
	if err != nil {
		return nil, wrap(err, "message")
	}
	return m, nil
}

// StartTurn takes the conversation's turn lock and pins the agent version the turn runs: the
// one the chat's settings resolve to. A template given here becomes the chat's choice first.
func (s *Service) StartTurn(ctx context.Context, caller *auth.Caller, rid uuid.UUID, template string) (*api.Turn, error) {
	conv, err := s.Get(ctx, caller, &conversationKind, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Write, rid); err != nil {
		return nil, err
	}
	if template != "" {
		var spec api.ConversationSpec
		_ = json.Unmarshal(conv.Spec, &spec)
		if template != uriString(spec.Template) {
			chosen := api.Uri(template)
			spec.Template = &chosen
			if conv, _, err = s.UpdateSpec(ctx, caller, conversationKind, UpdateSpecInput{RID: rid, Spec: mustJSON(spec)}); err != nil {
				return nil, err
			}
		}
	}
	settings, err := s.chatSettings(ctx, caller, conv)
	if err != nil {
		return nil, err
	}
	turn := uuid.NewString()
	var by *uuid.UUID
	if pid := caller.PID(); pid != uuid.Nil {
		by = &pid
	}
	if err := s.Store.StartTurn(ctx, rid, turn, by); err != nil {
		if store.IsConflict(err) {
			return nil, Conflict("turn_active", "a turn is already running in this conversation", nil)
		}
		return nil, wrap(err, "conversation")
	}
	return &api.Turn{Turn: turn, Template: settings.Agent.Uri, StartedAt: time.Now().UTC()}, nil
}

// EndTurn releases the turn lock.
func (s *Service) EndTurn(ctx context.Context, caller *auth.Caller, rid uuid.UUID, turn string) error {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Write, rid); err != nil {
		return err
	}
	return s.Store.EndTurn(ctx, rid, turn)
}

// ConversationResources lists what a conversation produced.
func (s *Service) ConversationResources(ctx context.Context, caller *auth.Caller, rid uuid.UUID) ([]store.Resource, error) {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return nil, err
	}
	page, err := s.List(ctx, caller, nil, ListFilter{Origin: &rid, Limit: 200})
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}
