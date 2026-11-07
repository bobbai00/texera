// Package catalog is the domain service of the catalog: every operation of the contract, over
// the store and the ports, independent of HTTP and MCP. One Service, one file per area:
// resources (the generic operations over every kind), files, executions, compute,
// conversations, credentials, iam, lineage and seed.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
)

// Config is what the service needs to know about its deployment.
type Config struct {
	// PublicURL is the gateway URL as clients see it.
	PublicURL string
	// APIPrefix is where the catalog API is mounted.
	APIPrefix string
	// OIDCIssuer and OIDCClientID are published to the app before login.
	OIDCIssuer   string
	OIDCClientID string
	// Branding of the deployment.
	BrandName string
	// Warehouse is the name of the platform's warehouse, in the lake and in the catalog, and
	// WarehouseStore the deployment's own store for warehouses, as the lake and the units reach
	// it: its key prefix is the platform warehouse's place, and a warehouse someone makes
	// without a store of their own gets another place in the same bucket.
	Warehouse      string
	WarehouseStore ports.WarehouseStorage
	// LineageCallbackURL is where units post OpenLineage events, as a unit reaches it.
	LineageCallbackURL string
	PresignTTL         time.Duration
	LeaseTTL           time.Duration
	MaxDownloadBytes   int64
	// WatchBeat is how often an open watch is kept alive and its watcher's right to read is
	// asked again; 15 seconds when unset.
	WatchBeat time.Duration
	// The seeds of the dev stack.
	StaticUnitEndpoint string
	StaticUnitName     string
	StaticUnitClientID string
	BioMcpURL          string
	BioMcpKey          string
	ModelName          string
	ModelSecretPath    string
}

// Service is the catalog.
type Service struct {
	Store       *store.Store
	PDP         *authz.PDP
	Relay       *authz.Relay
	Identity    ports.Identity
	Secrets     ports.SecretStore
	Blobs       ports.BlobStore
	Units       ports.UnitProvider
	Workloads   ports.Workloads
	Lake        ports.Lake
	LineageSink ports.LineageSink
	Config      Config
	Log         *slog.Logger

	mu            sync.RWMutex
	system        *store.Principal
	systemProject *store.Resource
	settings      *store.Resource

	eventsOnce sync.Once
	broker     *Broker
}

// Error is a failure the API renders: a status, a code and a message.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// NotFound names what is missing.
func NotFound(what string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "not_found", Message: what + " not found"}
}

// Forbidden is a negative decision.
func Forbidden() *Error {
	return &Error{Status: http.StatusForbidden, Code: "forbidden", Message: "the caller may not do this"}
}

// Invalid is a bad request.
func Invalid(msg string, details map[string]any) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "invalid", Message: msg, Details: details}
}

// Conflict is a refused write.
func Conflict(code, msg string, details map[string]any) *Error {
	return &Error{Status: http.StatusConflict, Code: code, Message: msg, Details: details}
}

// Gone names what the retention policy removed.
func Gone(what string, at time.Time) *Error {
	return &Error{Status: http.StatusGone, Code: "expired", Message: what + " expired on " + at.UTC().Format(time.RFC3339), Details: map[string]any{"expiredAt": at.UTC()}}
}

// Precondition is a failed If-Match.
func Precondition() *Error {
	return &Error{Status: http.StatusPreconditionFailed, Code: "precondition_failed", Message: "the resource changed; reload it and send its etag"}
}

// Unavailable is a peer that did not answer.
func Unavailable(what string, err error) *Error {
	return &Error{Status: http.StatusBadGateway, Code: "unavailable", Message: what + ": " + err.Error()}
}

// UnitFailed translates a failed call to a computing unit. What the engine refused keeps its class
// and its own words, so a person or an agent reads the real reason; an engine that failed still says
// what it said; a unit that did not answer is a peer that is unavailable.
func UnitFailed(err error) *Error {
	var refused *engine.UnitError
	if !errors.As(err, &refused) {
		return Unavailable("unit", err)
	}
	message := refused.Message()
	switch refused.Status {
	case http.StatusBadRequest, http.StatusUnprocessableEntity:
		return Invalid(message, nil)
	case http.StatusNotFound:
		return &Error{Status: http.StatusNotFound, Code: "not_found", Message: message}
	case http.StatusConflict:
		return Conflict("conflict", message, nil)
	}
	return &Error{Status: http.StatusBadGateway, Code: "unit_error", Message: "unit: " + message}
}

// wrap translates store and decision errors into API errors.
func wrap(err error, what string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, store.ErrNotFound):
		return NotFound(what)
	case errors.Is(err, store.ErrPrecondition):
		return Precondition()
	case errors.Is(err, store.ErrConflict):
		return Conflict("conflict", err.Error(), nil)
	case errors.Is(err, authz.ErrForbidden):
		return Forbidden()
	}
	return err
}

// changing are the permissions that change a resource or add to it.
var changing = map[string]bool{authz.Write: true, authz.Share: true, authz.Delete: true, authz.Rotate: true, authz.Execute: true}

// require checks a permission on a resource. What the platform ships is the platform's alone
// to change: a permission that changes a built-in resource, or adds to it, is refused for
// everyone else, an administrator included, since the next start puts back what ships.
func (s *Service) require(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) error {
	if changing[permission] && !caller.Service {
		if r, err := s.Store.GetResource(ctx, rid); err == nil && s.builtIn(r) {
			return Conflict("builtin", fmt.Sprintf("%s is built in: it changes with the platform, not through the API", r.Name), nil)
		}
	}
	return s.decide(ctx, caller, permission, rid)
}

// decide asks the decision point alone, for a permission that gates a read.
func (s *Service) decide(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) error {
	return wrap(s.PDP.Require(ctx, caller, permission, rid), "")
}

// builtIn reports whether the platform ships a resource: it lives in the platform's project,
// or is that project.
func (s *Service) builtIn(r *store.Resource) bool {
	system := s.SystemProject()
	return system != nil && r.ProjectRID != nil && *r.ProjectRID == system.RID
}

// readableBy returns the principal a list is filtered for: nil for administrators and
// services, who see everything.
func readableBy(caller *auth.Caller) *uuid.UUID {
	if caller.Service || caller.Admin() {
		return nil
	}
	pid := caller.PID()
	return &pid
}

// System returns the platform principal.
func (s *Service) System() *store.Principal {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.system
}

// SystemProject returns the project of the built-in resources.
func (s *Service) SystemProject() *store.Resource {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.systemProject
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(fmt.Sprintf(`{"error":%q}`, err.Error()))
	}
	return b
}

func parseRid(s string) (uuid.UUID, error) {
	rid, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, Invalid("not a resource id: "+s, nil)
	}
	return rid, nil
}
