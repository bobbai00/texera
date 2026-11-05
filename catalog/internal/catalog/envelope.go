package catalog

import (
	"encoding/json"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

const apiVersion = "catalog.texera.apache.org/v1"

// URI names a resource.
func URI(r *store.Resource) uri.Ref {
	k, _ := kinds.ByName(r.Kind)
	if k.Nested && r.ParentRID != nil {
		return uri.Nested(k, r.ParentRID.String(), r.RID.String())
	}
	if k.Singleton {
		return uri.Ref{Kind: k}
	}
	return uri.Of(k, r.RID.String())
}

// Envelope renders a resource row as the untyped envelope; the typed envelopes have the same
// JSON shape.
func Envelope(r *store.Resource) api.Resource {
	spec := map[string]any{}
	_ = json.Unmarshal(r.Spec, &spec)
	out := api.Resource{
		ApiVersion: apiVersion,
		Kind:       api.ResourceKind(r.Kind),
		Metadata:   Metadata(r),
		Spec:       spec,
	}
	if len(r.Status) > 0 {
		status := map[string]any{}
		if err := json.Unmarshal(r.Status, &status); err == nil {
			out.Status = &status
		}
	}
	return out
}

// Metadata renders a resource's metadata.
func Metadata(r *store.Resource) api.ResourceMetadata {
	m := api.ResourceMetadata{
		Rid:        api.Rid(r.RID.String()),
		Uri:        api.Uri(URI(r).String()),
		Name:       r.Name,
		Owner:      api.Pid(r.OwnerPID.String()),
		Visibility: api.Visibility(r.Visibility),
		Head:       api.Vno(r.HeadVno),
		Etag:       r.Etag,
		CreatedBy:  api.Pid(r.CreatedByPID.String()),
		CreatedAt:  r.CreatedAt,
		UpdatedAt:  r.UpdatedAt,
	}
	if r.Description != nil {
		m.Description = r.Description
	}
	if r.ParentRID != nil {
		p := api.Rid(r.ParentRID.String())
		m.Parent = &p
	}
	if r.ProjectRID != nil {
		m.Project = api.Rid(r.ProjectRID.String())
	}
	if len(r.Labels) > 0 {
		labels := r.Labels
		m.Labels = &labels
	}
	if r.Origin != nil {
		m.Origin = originOf(r.Origin)
	}
	return m
}

func originOf(o *store.Origin) *api.Origin {
	if o == nil {
		return nil
	}
	out := &api.Origin{Conversation: api.Rid(o.Conversation.String()), Turn: o.Turn}
	if o.Template != "" {
		t := api.Uri(o.Template)
		out.Template = &t
	}
	return out
}

// VersionOf renders a version with its content.
func VersionOf(r *store.Resource, v *store.Version) api.Version {
	var content any
	if len(v.Content) > 0 {
		_ = json.Unmarshal(v.Content, &content)
	}
	return api.Version{
		Rid:         api.Rid(v.RID.String()),
		Uri:         api.Uri(URI(r).WithVersion(v.Vno).String()),
		Kind:        api.ResourceKind(r.Kind),
		Vno:         api.Vno(v.Vno),
		ContentKind: api.ContentKind(v.ContentKind),
		Digest:      api.Digest(v.Digest),
		Content:     content,
		Message:     v.Message,
		CreatedBy:   api.Pid(v.CreatedByPID.String()),
		Origin:      originOf(v.Origin),
		CreatedAt:   v.CreatedAt,
	}
}

// SummaryOf renders a version without its content.
func SummaryOf(r *store.Resource, v *store.Version) api.VersionSummary {
	return api.VersionSummary{
		Rid:         api.Rid(v.RID.String()),
		Uri:         api.Uri(URI(r).WithVersion(v.Vno).String()),
		Vno:         api.Vno(v.Vno),
		ContentKind: api.ContentKind(v.ContentKind),
		Digest:      api.Digest(v.Digest),
		Message:     v.Message,
		CreatedBy:   api.Pid(v.CreatedByPID.String()),
		Origin:      originOf(v.Origin),
		CreatedAt:   v.CreatedAt,
	}
}

// GrantOf renders a grant.
func GrantOf(g store.Grant) api.Grant {
	return api.Grant{Rid: api.Rid(g.RID.String()), Principal: api.Pid(g.PID.String()), Relation: api.Relation(g.Relation), CreatedAt: g.CreatedAt}
}

// PrincipalOf renders a principal.
func PrincipalOf(p *store.Principal) api.Principal {
	out := api.Principal{Pid: api.Pid(p.PID.String()), Kind: api.PrincipalKind(p.Kind), DisplayName: p.DisplayName, CreatedAt: p.CreatedAt}
	if p.Subject != nil && p.Kind == "user" {
		out.Subject = p.Subject
	}
	out.Email = p.Email
	return out
}

// EdgeOf renders an edge.
func EdgeOf(e store.Edge) api.Edge {
	out := api.Edge{From: api.Uri(e.From), Relation: api.EdgeRelation(e.Relation), To: api.Uri(e.To), Field: e.Field, At: e.At}
	if e.ExecutionRID != nil {
		rid := api.Rid(e.ExecutionRID.String())
		out.Execution = &rid
	}
	if len(e.Attrs) > 0 {
		attrs := map[string]any{}
		if err := json.Unmarshal(e.Attrs, &attrs); err == nil {
			out.Attrs = &attrs
		}
	}
	return out
}

// MessageOf renders a stored message in the contract's shape.
func MessageOf(m *store.Message) api.Message {
	out := api.Message{Conversation: api.Rid(m.ConversationRID.String()), Seq: m.Seq, Turn: m.Turn, Role: api.MessageRole(m.Role), Author: api.Pid(m.AuthorPID.String()), CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}
	if m.Template != nil {
		t := api.Uri(*m.Template)
		out.Template = &t
	}
	if m.ModelEndpoint != nil {
		e := api.Uri(*m.ModelEndpoint)
		out.ModelEndpoint = &e
	}
	if m.McpServers != nil {
		servers := make([]api.Uri, len(m.McpServers))
		for i, uri := range m.McpServers {
			servers[i] = api.Uri(uri)
		}
		out.McpServers = &servers
	}
	_ = json.Unmarshal(m.Parts, &out.Parts)
	if out.Parts == nil {
		out.Parts = []api.MessagePart{}
	}
	return out
}
