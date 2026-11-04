package catalog

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// SettingsRID is the fixed id of the settings singleton.
var SettingsRID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("texera://settings"))

// Me describes the caller.
func (s *Service) Me(ctx context.Context, caller *auth.Caller) (*api.Me, error) {
	home, err := s.HomeProject(ctx, caller)
	if err != nil {
		return nil, err
	}
	prefs := map[string]any{}
	_ = json.Unmarshal(caller.Principal.Preferences, &prefs)
	out := &api.Me{Principal: PrincipalOf(caller.Principal), HomeProject: api.Rid(home.RID.String()), Admin: caller.Admin(), Preferences: prefs}
	if sys := s.SystemProject(); sys != nil {
		out.SystemProject = api.Rid(sys.RID.String())
	}
	return out, nil
}

// UpdatePreferences replaces the caller's preferences.
func (s *Service) UpdatePreferences(ctx context.Context, caller *auth.Caller, prefs json.RawMessage) (map[string]any, error) {
	p, err := s.Store.UpdatePreferences(ctx, caller.PID(), prefs)
	if err != nil {
		return nil, wrap(err, "principal")
	}
	out := map[string]any{}
	_ = json.Unmarshal(p.Preferences, &out)
	return out, nil
}

// Principals searches people and groups.
func (s *Service) Principals(ctx context.Context, q, kind string, limit int) ([]store.Principal, error) {
	known, err := s.Store.SearchPrincipals(ctx, q, kind, limit)
	if err != nil {
		return nil, err
	}
	// People who have not logged in yet come from the identity provider's directory and are
	// recorded so they can be granted access; a failing directory degrades to the catalog's own.
	if strings.TrimSpace(q) == "" || (kind != "" && kind != "user") {
		return known, nil
	}
	users, err := s.Identity.SearchUsers(ctx, q, limit)
	if err != nil {
		s.Log.Warn("user search", "err", err)
		return known, nil
	}
	seen := map[string]bool{}
	for _, p := range known {
		if p.Subject != nil {
			seen[*p.Subject] = true
		}
	}
	for _, u := range users {
		if seen[u.Subject] || len(known) >= limit && limit > 0 {
			continue
		}
		p, err := s.Store.ImportUser(ctx, u.Subject, u.DisplayName, u.Email)
		if err != nil {
			return nil, err
		}
		known = append(known, *p)
	}
	return known, nil
}

// Principal returns one principal.
func (s *Service) Principal(ctx context.Context, pid uuid.UUID) (*store.Principal, error) {
	p, err := s.Store.GetPrincipal(ctx, pid)
	if err != nil {
		return nil, NotFound("principal " + pid.String())
	}
	return p, nil
}

func (s *Service) settingsResource() *store.Resource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settings
}

// Settings returns the deployment's settings.
func (s *Service) Settings(ctx context.Context, caller *auth.Caller) (*store.Resource, error) {
	r, err := s.Store.GetResource(ctx, SettingsRID)
	if err != nil {
		return nil, NotFound("settings")
	}
	return r, nil
}

// UpdateSettings replaces the settings; administrators only.
func (s *Service) UpdateSettings(ctx context.Context, caller *auth.Caller, spec json.RawMessage, ifMatch string) (*store.Resource, error) {
	if !caller.Admin() && !caller.Service {
		return nil, Forbidden()
	}
	k, _ := kinds.ByName("settings")
	normalized, err := s.prepareSpec(ctx, caller, k, "settings", spec)
	if err != nil {
		return nil, err
	}
	references, err := s.references(ctx, caller, SettingsRID, uri.Ref{Kind: k}, normalized)
	if err != nil {
		return nil, err
	}
	r, _, err := s.Store.UpdateSpec(ctx, store.SpecUpdate{RID: SettingsRID, Spec: normalized, IfMatch: ifMatch, ContentKind: "spec", Content: normalized, CreatedByPID: caller.PID(), References: references})
	if err != nil {
		return nil, wrap(err, "settings")
	}
	s.mu.Lock()
	s.settings = r
	s.mu.Unlock()
	return r, nil
}

// PublicSettings is what the app needs before login.
func (s *Service) PublicSettings(ctx context.Context) (*api.PublicSettings, error) {
	out := &api.PublicSettings{Branding: api.Branding{Name: s.Config.BrandName}, Auth: api.AuthSettings{Issuer: s.Config.OIDCIssuer, ClientId: s.Config.OIDCClientID}}
	if r, err := s.Store.GetResource(ctx, SettingsRID); err == nil {
		var spec api.SettingsSpec
		if json.Unmarshal(r.Spec, &spec) == nil && spec.Branding.Name != "" {
			out.Branding = spec.Branding
		}
	}
	return out, nil
}

// settingsSpec returns the current settings spec, or zero when unseeded.
func (s *Service) settingsSpec(ctx context.Context) api.SettingsSpec {
	var spec api.SettingsSpec
	if r, err := s.Store.GetResource(ctx, SettingsRID); err == nil {
		_ = json.Unmarshal(r.Spec, &spec)
	}
	return spec
}

// projectSpec returns a project's spec.
func (s *Service) projectSpec(ctx context.Context, project *uuid.UUID) api.ProjectSpec {
	var spec api.ProjectSpec
	if project == nil {
		return spec
	}
	if r, err := s.Store.GetResource(ctx, *project); err == nil {
		_ = json.Unmarshal(r.Spec, &spec)
	}
	return spec
}

// defaultTemplate is the template a new chat starts with: the caller's home project's
// default, then the deployment's.
func (s *Service) defaultTemplate(ctx context.Context, caller *auth.Caller) (string, error) {
	home, err := s.HomeProject(ctx, caller)
	if err != nil {
		return "", err
	}
	if spec := s.projectSpec(ctx, &home.RID); spec.DefaultAgentTemplate != nil && *spec.DefaultAgentTemplate != "" {
		return string(*spec.DefaultAgentTemplate), nil
	}
	if spec := s.settingsSpec(ctx); spec.Defaults.AgentTemplate != nil && *spec.Defaults.AgentTemplate != "" {
		return string(*spec.Defaults.AgentTemplate), nil
	}
	return "", Invalid("no default agent template: name one in the conversation's spec", nil)
}
