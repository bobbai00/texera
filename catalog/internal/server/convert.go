package server

import (
	"encoding/base64"
	"encoding/json"
	"strconv"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/store"
)

func pidStr(p *uuid.UUID) *api.Pid {
	if p == nil {
		return nil
	}
	s := p.String()
	return &s
}

func ridStr(r *uuid.UUID) *api.Rid {
	if r == nil {
		return nil
	}
	s := r.String()
	return &s
}

func originOf(o *store.Origin) *api.Origin {
	if o == nil {
		return nil
	}
	return &api.Origin{Conversation: o.Conversation.String(), Seq: o.Seq}
}

// originFor returns the chat turn the calling agent acts in (attested by the platform through
// the agent assertion), else the explicit origin of the request body.
func originFor(caller *authn.Caller, o *api.Origin) (*store.Origin, error) {
	if caller != nil && caller.Origin != nil {
		return caller.Origin, nil
	}
	return originIn(o)
}

func originIn(o *api.Origin) (*store.Origin, error) {
	if o == nil {
		return nil, nil
	}
	rid, err := uuid.Parse(o.Conversation)
	if err != nil {
		return nil, badRequest("origin.conversation is not a UUID")
	}
	return &store.Origin{Conversation: rid, Seq: o.Seq}, nil
}

func metadataOf(r *store.Resource) api.ResourceMetadata {
	m := api.ResourceMetadata{
		Rid:         r.RID.String(),
		Name:        r.Name,
		Description: r.Description,
		Project:     ridStr(r.ParentRID),
		Owner:       r.OwnerPID.String(),
		Visibility:  api.Visibility(r.Visibility),
		HeadVersion: r.HeadVno,
		CreatedBy:   r.CreatedByPID.String(),
		OnBehalfOf:  pidStr(r.OnBehalfOfPID),
		Origin:      originOf(r.Origin),
		CreatedAt:   r.CreatedAt,
		UpdatedAt:   r.UpdatedAt,
	}
	if len(r.Labels) > 0 {
		l := r.Labels
		m.Labels = &l
	}
	return m
}

func toResource(r *store.Resource) api.Resource {
	out := api.Resource{
		ApiVersion: api.ResourceApiVersionCatalogTexeraApacheOrgv1,
		Kind:       api.ResourceKind(r.Kind),
		Metadata:   metadataOf(r),
		Spec:       map[string]any{},
	}
	_ = json.Unmarshal(r.Spec, &out.Spec)
	if len(r.Status) > 0 && string(r.Status) != "null" {
		st := map[string]any{}
		if err := json.Unmarshal(r.Status, &st); err == nil {
			out.Status = &st
		}
	}
	return out
}

func toVersion(v *store.Version, kind string) api.ResourceVersion {
	out := api.ResourceVersion{
		Rid:         v.RID.String(),
		Kind:        api.ResourceKind(kind),
		Vno:         v.Vno,
		ContentKind: api.ContentKind(v.ContentKind),
		ContentRef:  v.ContentRef,
		Message:     v.Message,
		CreatedBy:   v.CreatedByPID.String(),
		OnBehalfOf:  pidStr(v.OnBehalfOfPID),
		Origin:      originOf(v.Origin),
		CreatedAt:   v.CreatedAt,
	}
	if len(v.Content) > 0 && string(v.Content) != "null" {
		var c any
		if err := json.Unmarshal(v.Content, &c); err == nil {
			out.Content = c
		}
	}
	return out
}

func toPrincipal(p *store.Principal) api.Principal {
	return api.Principal{
		Pid:         p.PID.String(),
		Kind:        api.PrincipalKind(p.Kind),
		DisplayName: p.DisplayName,
		Subject:     p.Subject,
		Email:       p.Email,
		Sponsor:     pidStr(p.SponsorPID),
		CreatedAt:   p.CreatedAt,
	}
}

func toGrant(g *store.Grant) api.Grant {
	return api.Grant{Rid: g.RID.String(), Principal: g.PID.String(), Relation: api.Relation(g.Relation), CreatedAt: g.CreatedAt}
}

func toMessage(m *store.Message) api.Message {
	out := api.Message{
		Conversation: m.ConversationRID.String(),
		Seq:          m.Seq,
		Role:         api.MessageRole(m.Role),
		Author:       m.AuthorPID.String(),
		OnBehalfOf:   pidStr(m.OnBehalfOfPID),
		CreatedAt:    m.CreatedAt,
		Parts:        []api.MessagePart{},
	}
	_ = json.Unmarshal(m.Parts, &out.Parts)
	return out
}

func toAgent(a *store.Agent) api.Agent {
	return api.Agent{
		Pid:          a.PID.String(),
		Template:     api.VersionRef{Rid: a.TemplateRID.String(), Vno: a.TemplateVno},
		SpawnedBy:    pidStr(a.SpawnedByPID),
		Conversation: ridStr(a.ConversationRID),
		Execution:    ridStr(a.EID),
		Opid:         a.Opid,
		Lifetime:     api.AgentLifetime(a.Lifetime),
		Status:       api.AgentStatus(a.Status),
		CreatedAt:    a.CreatedAt,
	}
}

func toExecution(e *store.Execution, inputs []store.VersionRef, results []store.PortResult) api.Execution {
	out := api.Execution{
		Eid:           e.EID.String(),
		Name:          e.Name,
		Workflow:      api.VersionRef{Rid: e.WorkflowRID.String(), Vno: e.WorkflowVno},
		ComputingUnit: e.CuRID.String(),
		Actor:         e.ActorPID.String(),
		OnBehalfOf:    pidStr(e.OnBehalfOfPID),
		Origin:        originOf(e.Origin),
		Status:        api.ExecutionStatus(e.Status),
		CreatedAt:     e.CreatedAt,
		StartedAt:     e.StartedAt,
		FinishedAt:    e.FinishedAt,
		Inputs:        []api.VersionRef{},
		Operators:     map[string]api.OperatorRun{},
		Results:       []api.PortResult{},
	}
	if e.EnvRID != nil && e.EnvVno != nil {
		out.Environment = &api.VersionRef{Rid: e.EnvRID.String(), Vno: *e.EnvVno}
	}
	if len(e.Parameters) > 0 && string(e.Parameters) != "null" {
		p := map[string]any{}
		if err := json.Unmarshal(e.Parameters, &p); err == nil {
			out.Parameters = &p
		}
	}
	if len(e.Error) > 0 && string(e.Error) != "null" {
		var v any
		if err := json.Unmarshal(e.Error, &v); err == nil {
			out.Error = v
		}
	}
	if len(e.Operators) > 0 {
		_ = json.Unmarshal(e.Operators, &out.Operators)
	}
	for _, in := range inputs {
		out.Inputs = append(out.Inputs, api.VersionRef{Rid: in.RID.String(), Vno: in.Vno})
	}
	for _, r := range results {
		out.Results = append(out.Results, api.PortResult{Opid: r.Opid, Port: r.Port, Table: r.TableID, Snapshot: r.SnapshotID, TupleCount: r.TupleCount, Bytes: r.Bytes, Hash: r.Hash})
	}
	return out
}

func toEdge(e store.VersionEdge) api.VersionEdge {
	out := api.VersionEdge{
		From: api.VersionRef{Rid: e.From.RID.String(), Vno: e.From.Vno},
		To:   api.VersionRef{Rid: e.To.RID.String(), Vno: e.To.Vno},
		Kind: api.VersionEdgeKind(e.Kind),
	}
	if e.EID != nil {
		s := e.EID.String()
		out.Execution = &s
	}
	return out
}

// Cursors are opaque offsets.
func decodeCursor(c *string) int {
	if c == nil || *c == "" {
		return 0
	}
	b, err := base64.RawURLEncoding.DecodeString(*c)
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(string(b))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func encodeCursor(offset, got, limit int) *string {
	if got < limit {
		return nil
	}
	s := base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset + got)))
	return &s
}

func limitOf(l *int32, def int) int {
	if l == nil || *l <= 0 {
		return def
	}
	if *l > 500 {
		return 500
	}
	return int(*l)
}

func parseRid(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, badRequest("%q is not a valid id", s)
	}
	return id, nil
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
