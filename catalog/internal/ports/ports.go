// Package ports defines the interfaces the catalog's services depend on: every peer with an
// open protocol sits behind one of them, with one adapter per product under
// internal/adapters and a contract suite per port under contracttest. The services never
// import an adapter.
package ports

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// Claims is what a verified token says about its bearer.
type Claims struct {
	Subject  string
	Name     string
	Username string
	Email    string
	// ClientID is the OAuth client the token was issued to (azp).
	ClientID string
	// Roles are the realm roles; "admin" makes an administrator.
	Roles []string
	// Service is true for the platform's own service client.
	Service bool
}

// Identity verifies bearer tokens and mints the catalog's own (OIDC).
type Identity interface {
	Verify(ctx context.Context, token string) (Claims, error)
	ServiceToken(ctx context.Context) (string, error)
}

// ErrUnauthenticated is returned for a missing or invalid token.
var ErrUnauthenticated = errors.New("unauthenticated")

// Tuple is one relationship: subject has relation on object.
type Tuple struct {
	Object   string
	Relation string
	Subject  string
}

// Authorizer answers relationship questions and stores tuples (OpenFGA).
type Authorizer interface {
	// Check reports whether the subject has the computed permission (can_read, ...) on the object.
	Check(ctx context.Context, subject, permission, object string) (bool, error)
	// Write applies tuple writes and deletes; a duplicate write and a missing delete are not errors.
	Write(ctx context.Context, writes, deletes []Tuple) error
}

// SecretStore keeps secret values by path (the Vault KV API).
type SecretStore interface {
	Put(ctx context.Context, path string, fields map[string]string) error
	Get(ctx context.Context, path string) (map[string]string, error)
	Delete(ctx context.Context, path string) error
}

// ErrSecretNotFound is returned when a path holds no secret.
var ErrSecretNotFound = errors.New("secret not found")

// BlobStore keeps content-addressed bytes (the S3 API).
type BlobStore interface {
	// Put stores the bytes under their digest; storing the same digest twice is a no-op.
	Put(ctx context.Context, digest string, size int64, body io.Reader, contentType string) error
	Exists(ctx context.Context, digest string) (bool, error)
	// Get reads from offset; length <= 0 reads to the end.
	Get(ctx context.Context, digest string, offset, length int64) (io.ReadCloser, error)
	// Presign returns a URL that reads the blob, served under filename, for ttl.
	Presign(ctx context.Context, digest, filename string, ttl time.Duration) (string, error)
}

// ErrBlobNotFound is returned when a digest is not stored.
var ErrBlobNotFound = errors.New("blob not found")

// UnitProvider provisions computing units: static today, processes and Kubernetes later.
type UnitProvider interface {
	// Endpoint returns the unit's base URL as the catalog reaches it, "" while not provisioned.
	Endpoint(ctx context.Context, spec api.ComputingUnitSpec) (string, error)
	Terminate(ctx context.Context, spec api.ComputingUnitSpec) error
}

// LineageSink forwards OpenLineage events to an external consumer.
type LineageSink interface {
	Emit(ctx context.Context, event json.RawMessage) error
}
