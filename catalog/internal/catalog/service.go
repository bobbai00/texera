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

	"github.com/apache/texera/catalog/internal/api"
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
	// BrandName is Texera's name until its admins set one.
	BrandName string
	// Warehouse is the name of the warehouse the release ships, in the lake and in the catalog,
	// and WarehouseStore the deployment's own store for warehouses, as the lake and the units
	// reach it: its key prefix is that warehouse's place, and a warehouse someone makes without
	// a store of their own gets another place in the same bucket.
	Warehouse      string
	WarehouseStore ports.WarehouseStorage
	// LineageCallbackURL is where units post OpenLineage events, as a unit reaches it.
	LineageCallbackURL string
	PresignTTL         time.Duration
	LeaseTTL           time.Duration
	MaxDownloadBytes   int64
	// ImportMaxBytes is the largest file an import fetches from the internet; 1 GiB when unset.
	ImportMaxBytes int64
	// UploadGrace is how long an upload that no version and no staging names is kept before the
	// retention sweep removes it: long enough for it to be committed. A day when unset.
	UploadGrace time.Duration
	// WatchBeat is how often an open watch is kept alive and its watcher's right to read is
	// asked again; 15 seconds when unset.
	WatchBeat time.Duration
	// ProfileUnits is where a unit made from a profile runs: on the deployment's Kubernetes
	// (kubernetes, the default), or as the public unit (static), which takes the
	// profile's packages but keeps its own size, as on Compose.
	ProfileUnits api.UnitProvider
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
	// Importer fetches the files imports bring in; the public client (PublicClient) when nil.
	Importer *http.Client
	Config   Config
	Log      *slog.Logger

	mu     sync.RWMutex
	system *store.Principal
	// root is Texera, the project every project inherits from.
	root *store.Resource
	// warehouse is the warehouse the release ships, on the deployment's own store.
	warehouse uuid.UUID

	eventsOnce sync.Once
	broker     *Broker

	importerOnce   sync.Once
	publicImporter *http.Client
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

// require checks a permission on a resource. Everyone, Texera's admins included, holds what
// the authorization model gives them and nothing more.
func (s *Service) require(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) error {
	return s.decide(ctx, caller, permission, rid)
}

// decide asks the decision point.
func (s *Service) decide(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) error {
	return wrap(s.PDP.Require(ctx, caller, permission, rid), "")
}

// readableBy returns the principal a list is filtered for: nil for the platform's services,
// which see everything.
func readableBy(caller *auth.Caller) *uuid.UUID {
	if caller.Service {
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
