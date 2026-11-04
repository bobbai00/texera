// Package keycloak is the Identity and Workloads adapter: OIDC token verification against the
// provider's keys, client-credentials tokens for the catalog itself, and the admin API for the
// directory and for unit identities. Nothing here is specific to Keycloak beyond the
// realm-roles claim and the admin API's shape.
package keycloak

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"

	"github.com/apache/texera/catalog/internal/ports"
)

// Options configure the adapter.
type Options struct {
	// Issuer is the issuer claim tokens carry.
	Issuer string
	// DiscoveryURL is where OIDC discovery runs when the issuer URL is not reachable from the
	// catalog; empty means the issuer.
	DiscoveryURL string
	// JWKSURL and TokenURL, when set, are used instead of what discovery returns.
	JWKSURL  string
	TokenURL string
	// Audience is the audience tokens must carry.
	Audience string
	// ServiceClientID and ServiceClientSecret are the catalog's own client.
	ServiceClientID     string
	ServiceClientSecret string
}

// Identity implements ports.Identity.
type Identity struct {
	opts     Options
	verifier *oidc.IDTokenVerifier
	tokenURL string

	mu     sync.Mutex
	token  string
	expiry time.Time
}

type claims struct {
	Subject           string `json:"sub"`
	Email             string `json:"email"`
	PreferredUsername string `json:"preferred_username"`
	Name              string `json:"name"`
	AuthorizedParty   string `json:"azp"`
	ClientID          string `json:"client_id"`
	RealmAccess       struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// New discovers the provider (retrying while the dev stack starts) and returns the adapter.
func New(ctx context.Context, opts Options) (*Identity, error) {
	id := &Identity{opts: opts, tokenURL: opts.TokenURL}
	discovery := opts.DiscoveryURL
	if discovery == "" {
		discovery = opts.Issuer
	}
	if opts.JWKSURL != "" {
		id.verifier = oidc.NewVerifier(opts.Issuer, oidc.NewRemoteKeySet(ctx, opts.JWKSURL), &oidc.Config{ClientID: opts.Audience})
	}
	if id.verifier == nil || id.tokenURL == "" {
		var provider *oidc.Provider
		var err error
		deadline := time.Now().Add(2 * time.Minute)
		for {
			provider, err = oidc.NewProvider(oidc.InsecureIssuerURLContext(ctx, opts.Issuer), discovery)
			if err == nil || time.Now().After(deadline) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(2 * time.Second):
			}
		}
		if err != nil {
			return nil, fmt.Errorf("oidc discovery at %s: %w", discovery, err)
		}
		if id.verifier == nil {
			id.verifier = provider.Verifier(&oidc.Config{ClientID: opts.Audience})
		}
		if id.tokenURL == "" {
			id.tokenURL = provider.Endpoint().TokenURL
		}
	}
	return id, nil
}

// Verify checks signature, issuer, audience and expiry.
func (id *Identity) Verify(ctx context.Context, raw string) (ports.Claims, error) {
	tok, err := id.verifier.Verify(ctx, raw)
	if err != nil {
		return ports.Claims{}, fmt.Errorf("%w: %v", ports.ErrUnauthenticated, err)
	}
	var c claims
	if err := tok.Claims(&c); err != nil {
		return ports.Claims{}, fmt.Errorf("%w: claims: %v", ports.ErrUnauthenticated, err)
	}
	subject := c.Subject
	if subject == "" {
		subject = tok.Subject
	}
	client := c.AuthorizedParty
	if client == "" {
		client = c.ClientID
	}
	return ports.Claims{
		Subject:  subject,
		Name:     c.Name,
		Username: c.PreferredUsername,
		Email:    c.Email,
		ClientID: client,
		Roles:    c.RealmAccess.Roles,
		Service:  id.opts.ServiceClientID != "" && client == id.opts.ServiceClientID,
	}, nil
}

// SearchUsers asks Keycloak's admin API for people matching the query, with the service
// client's token; the client needs the realm-management role view-users. The admin URL is
// the token URL's realm with /admin in front: .../realms/{r}/protocol/... -> .../admin/realms/{r}.
func (id *Identity) SearchUsers(ctx context.Context, q string, limit int) ([]ports.User, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	token, err := id.ServiceToken(ctx)
	if err != nil {
		return nil, err
	}
	base := adminURL(id.tokenURL)
	if base == "" {
		return nil, nil
	}
	params := url.Values{"search": {q}, "max": {strconv.Itoa(limit)}, "briefRepresentation": {"true"}, "enabled": {"true"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/users?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("user search: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("user search: status %d", resp.StatusCode)
	}
	var found []struct {
		ID        string `json:"id"`
		Username  string `json:"username"`
		FirstName string `json:"firstName"`
		LastName  string `json:"lastName"`
		Email     string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&found); err != nil {
		return nil, err
	}
	out := make([]ports.User, 0, len(found))
	for _, u := range found {
		if strings.HasPrefix(u.Username, "service-account-") {
			continue
		}
		name := strings.TrimSpace(u.FirstName + " " + u.LastName)
		if name == "" {
			name = u.Username
		}
		out = append(out, ports.User{Subject: u.ID, DisplayName: name, Email: u.Email})
	}
	return out, nil
}

// adminURL turns .../realms/{realm}/protocol/openid-connect/token into .../admin/realms/{realm}.
func adminURL(tokenURL string) string {
	i := strings.Index(tokenURL, "/realms/")
	j := strings.Index(tokenURL, "/protocol/")
	if i < 0 || j < i {
		return ""
	}
	return tokenURL[:i] + "/admin" + tokenURL[i:j]
}

// ServiceToken returns a cached client-credentials token, refreshed a minute before expiry.
func (id *Identity) ServiceToken(ctx context.Context) (string, error) {
	id.mu.Lock()
	defer id.mu.Unlock()
	if id.token != "" && time.Until(id.expiry) > time.Minute {
		return id.token, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {id.opts.ServiceClientID}, "client_secret": {id.opts.ServiceClientSecret}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, id.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("service token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("service token: status %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	id.token = body.AccessToken
	id.expiry = time.Now().Add(time.Duration(body.ExpiresIn) * time.Second)
	return id.token, nil
}
