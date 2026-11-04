// Package auth resolves the caller of a request: the bearer token is verified through the
// Identity port, the principal is found or created in the store, and the origin header of a
// chat turn is honored when the agent runtime's service token vouches for it.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// Caller is the authenticated identity of a request.
type Caller struct {
	// Principal is the person (or the platform) acting; nil for a unit.
	Principal *store.Principal
	// Service is true for the platform's own service client: the catalog itself when it
	// reaches a unit, the runtime's bookkeeping. A service caller passes every permission check.
	Service bool
	// Unit is true for a computing unit calling as itself: it has no principal and no
	// permission; the one thing it may do is report on the executions it runs.
	Unit   bool
	Token  string
	Claims ports.Claims
	// Origin is the chat turn the call acts in (X-Texera-Origin), honored only when a valid
	// service token accompanies it. Resources and versions the call creates carry it.
	Origin *store.Origin
}

// PID returns the caller's principal id; uuid.Nil for a unit.
func (c *Caller) PID() uuid.UUID {
	if c.Principal == nil {
		return uuid.Nil
	}
	return c.Principal.PID
}

// Admin reports whether the caller is a platform administrator.
func (c *Caller) Admin() bool { return c.Principal != nil && c.Principal.Admin }

// Resolver turns requests into callers.
type Resolver struct {
	identity ports.Identity
	store    *store.Store
	isUnit   func(clientID string) bool
}

// NewResolver builds a resolver; isUnit tells the clients computing units run as, whose
// tokens make no person.
func NewResolver(identity ports.Identity, st *store.Store, isUnit func(clientID string) bool) *Resolver {
	if isUnit == nil {
		isUnit = func(string) bool { return false }
	}
	return &Resolver{identity: identity, store: st, isUnit: isUnit}
}

// Resolve verifies the request's token and resolves the caller.
func (r *Resolver) Resolve(ctx context.Context, req *http.Request) (*Caller, error) {
	raw := Bearer(req.Header.Get("Authorization"))
	if raw == "" {
		raw = req.URL.Query().Get("access_token")
	}
	if raw == "" {
		return nil, fmt.Errorf("%w: no bearer token", ports.ErrUnauthenticated)
	}
	caller, err := r.FromToken(ctx, raw)
	if err != nil {
		return nil, err
	}
	if origin := req.Header.Get("X-Texera-Origin"); origin != "" {
		svc := req.Header.Get("X-Texera-Service-Token")
		vouched := caller.Service
		if !vouched && svc != "" {
			claims, err := r.identity.Verify(ctx, svc)
			vouched = err == nil && claims.Service
		}
		if !vouched {
			return nil, fmt.Errorf("%w: an origin needs a service token", ports.ErrUnauthenticated)
		}
		o, err := ParseOrigin(origin)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ports.ErrUnauthenticated, err)
		}
		caller.Origin = o
	}
	return caller, nil
}

// FromToken verifies a token and resolves its principal, creating a user on first sight.
func (r *Resolver) FromToken(ctx context.Context, raw string) (*Caller, error) {
	claims, err := r.identity.Verify(ctx, raw)
	if err != nil {
		return nil, err
	}
	if !claims.Service && r.isUnit(claims.ClientID) {
		return &Caller{Unit: true, Token: raw, Claims: claims}, nil
	}
	display := claims.Name
	if display == "" {
		display = claims.Username
	}
	if display == "" {
		display = claims.Subject
	}
	if claims.Service {
		display = "service:" + claims.ClientID
	}
	admin := false
	for _, role := range claims.Roles {
		if role == "admin" {
			admin = true
		}
	}
	p, _, err := r.store.EnsureUser(ctx, claims.Subject, display, claims.Email, admin)
	if err != nil {
		return nil, err
	}
	return &Caller{Principal: p, Service: claims.Service, Token: raw, Claims: claims}, nil
}

// ParseOrigin parses "conversation=<rid>;turn=<uuid>;template=<uri>".
func ParseOrigin(raw string) (*store.Origin, error) {
	o := &store.Origin{}
	for _, field := range strings.Split(raw, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(field), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "conversation":
			rid, err := uuid.Parse(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("origin conversation is not a UUID")
			}
			o.Conversation = rid
		case "turn":
			if _, err := uuid.Parse(strings.TrimSpace(value)); err != nil {
				return nil, fmt.Errorf("origin turn is not a UUID")
			}
			o.Turn = strings.TrimSpace(value)
		case "template":
			o.Template = strings.TrimSpace(value)
		}
	}
	if o.Conversation == uuid.Nil || o.Turn == "" {
		return nil, fmt.Errorf("origin needs conversation and turn")
	}
	return o, nil
}

// FormatOrigin renders an origin header value.
func FormatOrigin(o store.Origin) string {
	s := "conversation=" + o.Conversation.String() + ";turn=" + o.Turn
	if o.Template != "" {
		s += ";template=" + o.Template
	}
	return s
}

// Bearer extracts the token of an Authorization header.
func Bearer(h string) string {
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

// Middleware resolves the caller for every request and answers 401 otherwise; requests
// `public` accepts pass through without a caller.
func (r *Resolver) Middleware(public func(req *http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if public != nil && public(req) {
				next.ServeHTTP(w, req)
				return
			}
			caller, err := r.Resolve(req.Context(), req)
			if err != nil {
				w.Header().Set("WWW-Authenticate", `Bearer realm="texera"`)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": "unauthenticated", "message": err.Error()})
				return
			}
			next.ServeHTTP(w, req.WithContext(WithCaller(req.Context(), caller)))
		})
	}
}
