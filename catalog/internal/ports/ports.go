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
	// SearchUsers finds people in the identity provider's directory by name or email, so a
	// resource can be shared with someone who has not logged in yet. An empty query matches
	// nobody; an unsupported directory returns no users and no error.
	SearchUsers(ctx context.Context, q string, limit int) ([]User, error)
}

// User is a person as the identity provider knows them; Subject is what their tokens carry.
type User struct {
	Subject     string
	DisplayName string
	Email       string
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
	// Delete removes the bytes; a digest that is not stored is not an error.
	Delete(ctx context.Context, digest string) error
}

// ErrBlobNotFound is returned when a digest is not stored.
var ErrBlobNotFound = errors.New("blob not found")

// UnitProvider provisions computing units: static ones that already run, and Kubernetes ones
// the catalog creates.
type UnitProvider interface {
	// Endpoint makes sure the unit named by rid exists as its spec asks and returns its base
	// URL as the catalog reaches it, "" while it is not provisioned yet. It is called on every
	// status probe, so it must be idempotent and cheap once the unit exists. identity hands
	// the provider the unit's credential when it provisions the unit; a provider that does not
	// provision never calls it.
	Endpoint(ctx context.Context, rid string, spec api.ComputingUnitSpec, identity WorkloadSource) (string, error)
	// Terminate releases what the unit holds; a unit that does not exist is not an error.
	Terminate(ctx context.Context, rid string, spec api.ComputingUnitSpec) error
}

// WorkloadSource reads a unit's identity on demand.
type WorkloadSource func(ctx context.Context) (Workload, error)

// Workload is a unit's identity: the OAuth client it authenticates as, with its secret, and
// the subject its tokens carry, which the lake's grants name.
type Workload struct {
	ClientID string
	Secret   string
	Subject  string
}

// Workloads mints unit identities in the identity provider: one confidential client with a
// service account per unit, so a unit only ever reaches what its own grants allow.
type Workloads interface {
	// CreateWorkload creates the client named clientID, replacing one that exists, and
	// returns its credential and subject.
	CreateWorkload(ctx context.Context, clientID, displayName string) (Workload, error)
	// DeleteWorkload removes the client; a client that does not exist is not an error.
	DeleteWorkload(ctx context.Context, clientID string) error
	// WorkloadSubject returns the subject an existing client's tokens carry.
	WorkloadSubject(ctx context.Context, clientID string) (string, error)
}

// ErrWorkloadNotFound is returned when no client has the id.
var ErrWorkloadNotFound = errors.New("workload not found")

// Lake is the table catalog over the warehouse (the Iceberg REST catalog, Lakekeeper): it
// holds the result tables and enforces who may touch them.
type Lake interface {
	// Prepare makes the lake ready for this deployment: bootstrapped, with the warehouse the
	// units write to. Idempotent; called at startup.
	Prepare(ctx context.Context) error
	// OpenNamespace creates an execution's namespace and lets the workload with the subject
	// create and write tables in it; name labels the workload in the lake.
	OpenNamespace(ctx context.Context, namespace, subject, name string) error
	// DropNamespace drops the namespace with every table in it; a namespace that does not
	// exist is not an error.
	DropNamespace(ctx context.Context, namespace string) error
}

// LineageSink forwards OpenLineage events to an external consumer.
type LineageSink interface {
	Emit(ctx context.Context, event json.RawMessage) error
}
