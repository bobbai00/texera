// Package authn verifies bearer tokens against the identity provider and resolves the
// calling principal. The gateway verifies tokens too; the catalog verifies again because it
// is the policy decision point and must not trust its own ingress.
package authn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/store"
)

// Claims is the subset of token claims the catalog uses.
type Claims struct {
	Subject           string   `json:"sub"`
	Email             string   `json:"email"`
	PreferredUsername string   `json:"preferred_username"`
	Name              string   `json:"name"`
	AuthorizedParty   string   `json:"azp"`
	ClientID          string   `json:"client_id"`
	RealmAccess       struct { //nolint:revive
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// Caller is the authenticated identity of a request.
type Caller struct {
	// Principal is the effective principal: the user, or the service account's principal.
	Principal *store.Principal
	// Agent is the acting agent when an agent runtime calls on behalf of the user.
	Agent *store.Principal
	// IsService is true for client-credentials tokens of the platform's service client.
	IsService bool
	Token     string
	Claims    Claims
	// Origin is the chat turn an agent acts in (X-Texera-Origin, honored only with a valid
	// agent assertion). Resources, versions and executions the call creates carry it.
	Origin *store.Origin
}

// OnBehalfOf returns the user principal id the action is attributed to.
func (c *Caller) OnBehalfOf() uuid.UUID { return c.Principal.PID }

// Actor returns the principal performing the action: the agent when present, else the principal.
func (c *Caller) Actor() uuid.UUID {
	if c.Agent != nil {
		return c.Agent.PID
	}
	return c.Principal.PID
}

// Verifier verifies tokens and resolves principals.
type Verifier struct {
	verifier        *oidc.IDTokenVerifier
	store           *store.Store
	serviceClientID string
}

// NewVerifier checks tokens against the issuer's keys. With jwksURL it fetches the keys from
// there; otherwise it performs OIDC discovery, at discoveryURL when the issuer is not reachable
// from the catalog (empty means the issuer).
func NewVerifier(ctx context.Context, st *store.Store, issuer, discoveryURL, jwksURL, audience, serviceClientID string) (*Verifier, error) {
	if jwksURL != "" {
		keys := oidc.NewRemoteKeySet(ctx, jwksURL)
		return &Verifier{
			verifier:        oidc.NewVerifier(issuer, keys, &oidc.Config{ClientID: audience}),
			store:           st,
			serviceClientID: serviceClientID,
		}, nil
	}
	if discoveryURL == "" {
		discoveryURL = issuer
	}
	var provider *oidc.Provider
	var err error
	deadline := time.Now().Add(2 * time.Minute)
	for {
		provider, err = oidc.NewProvider(oidc.InsecureIssuerURLContext(ctx, issuer), discoveryURL)
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
		return nil, fmt.Errorf("oidc discovery at %s: %w", discoveryURL, err)
	}
	return &Verifier{
		verifier:        provider.Verifier(&oidc.Config{ClientID: audience}),
		store:           st,
		serviceClientID: serviceClientID,
	}, nil
}

// ErrUnauthenticated is returned for missing or invalid tokens.
var ErrUnauthenticated = errors.New("unauthenticated")

// VerifyToken checks signature, issuer, audience and expiry and returns the claims.
func (v *Verifier) VerifyToken(ctx context.Context, raw string) (Claims, error) {
	var claims Claims
	tok, err := v.verifier.Verify(ctx, raw)
	if err != nil {
		return claims, fmt.Errorf("%w: %v", ErrUnauthenticated, err)
	}
	if err := tok.Claims(&claims); err != nil {
		return claims, fmt.Errorf("%w: claims: %v", ErrUnauthenticated, err)
	}
	if claims.Subject == "" {
		claims.Subject = tok.Subject
	}
	return claims, nil
}

// Resolve verifies the request's bearer token and resolves the caller, creating the user
// principal on first sight. The agent assertion headers are honored only when the
// accompanying service token verifies.
func (v *Verifier) Resolve(ctx context.Context, r *http.Request) (*Caller, error) {
	raw := bearer(r.Header.Get("Authorization"))
	if raw == "" {
		raw = r.URL.Query().Get("access_token")
	}
	if raw == "" {
		return nil, fmt.Errorf("%w: no bearer token", ErrUnauthenticated)
	}
	claims, err := v.VerifyToken(ctx, raw)
	if err != nil {
		return nil, err
	}
	caller := &Caller{Token: raw, Claims: claims}
	caller.IsService = v.isServiceClaims(claims)
	display := claims.Name
	if display == "" {
		display = claims.PreferredUsername
	}
	if display == "" {
		display = claims.Subject
	}
	var email *string
	if claims.Email != "" {
		email = &claims.Email
	}
	if caller.IsService {
		display = "service:" + v.serviceClientID
	}
	p, _, err := v.store.EnsureUser(ctx, claims.Subject, display, email)
	if err != nil {
		return nil, err
	}
	caller.Principal = p

	if agentID := r.Header.Get("X-Texera-Agent"); agentID != "" {
		svc := r.Header.Get("X-Texera-Service-Token")
		if svc == "" && caller.IsService {
			svc = raw
		}
		if svc == "" {
			return nil, fmt.Errorf("%w: agent assertion without service token", ErrUnauthenticated)
		}
		sc, err := v.VerifyToken(ctx, svc)
		if err != nil || !v.isServiceClaims(sc) {
			return nil, fmt.Errorf("%w: invalid service token for agent assertion", ErrUnauthenticated)
		}
		pid, err := uuid.Parse(agentID)
		if err != nil {
			return nil, fmt.Errorf("%w: bad agent id", ErrUnauthenticated)
		}
		agent, err := v.store.GetPrincipal(ctx, pid)
		if err != nil || agent.Kind != "agent" {
			return nil, fmt.Errorf("%w: unknown agent", ErrUnauthenticated)
		}
		caller.Agent = agent
		if raw := r.Header.Get("X-Texera-Origin"); raw != "" {
			origin, err := ParseOrigin(raw)
			if err != nil {
				return nil, fmt.Errorf("%w: %v", ErrUnauthenticated, err)
			}
			caller.Origin = origin
		}
	}
	return caller, nil
}

// ParseOrigin parses "<conversation rid>:<message seq>".
func ParseOrigin(raw string) (*store.Origin, error) {
	rid, seqStr, ok := strings.Cut(strings.TrimSpace(raw), ":")
	if !ok {
		return nil, fmt.Errorf("origin must be <conversation>:<seq>")
	}
	conv, err := uuid.Parse(rid)
	if err != nil {
		return nil, fmt.Errorf("origin conversation is not a UUID")
	}
	seq, err := strconv.ParseInt(seqStr, 10, 64)
	if err != nil || seq < 0 {
		return nil, fmt.Errorf("origin seq is not a number")
	}
	return &store.Origin{Conversation: conv, Seq: seq}, nil
}

func (v *Verifier) isServiceClaims(c Claims) bool {
	azp := c.AuthorizedParty
	if azp == "" {
		azp = c.ClientID
	}
	return v.serviceClientID != "" && azp == v.serviceClientID
}

func bearer(h string) string {
	if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

type ctxKey struct{}

// WithCaller stores the caller in the context.
func WithCaller(ctx context.Context, c *Caller) context.Context {
	return context.WithValue(ctx, ctxKey{}, c)
}

// CallerFrom returns the caller stored in the context, or nil.
func CallerFrom(ctx context.Context) *Caller {
	c, _ := ctx.Value(ctxKey{}).(*Caller)
	return c
}

// Middleware resolves the caller for every request and rejects unauthenticated ones.
// Paths in `public` are passed through without a caller.
func (v *Verifier) Middleware(public func(r *http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if public != nil && public(r) {
				next.ServeHTTP(w, r)
				return
			}
			caller, err := v.Resolve(r.Context(), r)
			if err != nil {
				w.Header().Set("WWW-Authenticate", `Bearer realm="texera"`)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": "unauthenticated", "message": err.Error()})
				return
			}
			next.ServeHTTP(w, r.WithContext(WithCaller(r.Context(), caller)))
		})
	}
}
