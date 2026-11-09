package catalog

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// Me describes the caller.
func (s *Service) Me(ctx context.Context, caller *auth.Caller) (*api.Me, error) {
	home, err := s.HomeProject(ctx, caller)
	if err != nil {
		return nil, err
	}
	prefs := map[string]any{}
	_ = json.Unmarshal(caller.Principal.Preferences, &prefs)
	out := &api.Me{Principal: PrincipalOf(caller.Principal), HomeProject: api.Rid(home.RID.String()), Preferences: prefs}
	if root := s.Root(); root != nil {
		out.RootProject = api.Rid(root.RID.String())
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

// Public is what the app needs before anyone has signed in: Texera's look, and how to sign in.
func (s *Service) Public(ctx context.Context) (*api.PublicInfo, error) {
	out := &api.PublicInfo{Branding: api.Branding{Name: &s.Config.BrandName}, Auth: api.AuthSettings{Issuer: s.Config.OIDCIssuer, ClientId: s.Config.OIDCClientID}}
	if root := s.Root(); root != nil {
		if settings, err := s.settingsOf(ctx, root.RID); err == nil {
			if settings.Branding.Name != nil {
				out.Branding.Name = settings.Branding.Name
			}
			out.Branding.LogoUrl, out.Branding.LogoLargeUrl, out.Branding.Description = settings.Branding.LogoUrl, settings.Branding.LogoLargeUrl, settings.Branding.Description
		}
	}
	return out, nil
}
