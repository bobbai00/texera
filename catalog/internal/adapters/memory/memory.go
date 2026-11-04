// Package memory holds in-memory adapters for tests: a secret store, a blob store and an
// authorizer with the model's semantics (relation hierarchy, parent inheritance, the public
// wildcard, group membership).
package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/ports"
)

// Secrets is an in-memory ports.SecretStore.
type Secrets struct {
	mu   sync.Mutex
	data map[string]map[string]string
}

// NewSecrets returns an empty store.
func NewSecrets() *Secrets { return &Secrets{data: map[string]map[string]string{}} }

func (s *Secrets) Put(_ context.Context, path string, fields map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copied := map[string]string{}
	for k, v := range fields {
		copied[k] = v
	}
	s.data[strings.Trim(path, "/")] = copied
	return nil
}

func (s *Secrets) Get(_ context.Context, path string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fields, ok := s.data[strings.Trim(path, "/")]
	if !ok {
		return nil, ports.ErrSecretNotFound
	}
	copied := map[string]string{}
	for k, v := range fields {
		copied[k] = v
	}
	return copied, nil
}

func (s *Secrets) Delete(_ context.Context, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, strings.Trim(path, "/"))
	return nil
}

// Blobs is an in-memory ports.BlobStore.
type Blobs struct {
	mu   sync.Mutex
	data map[string][]byte
	// PublicURL prefixes presigned URLs.
	PublicURL string
}

// NewBlobs returns an empty store.
func NewBlobs() *Blobs { return &Blobs{data: map[string][]byte{}, PublicURL: "memory://blobs"} }

func (b *Blobs) Put(_ context.Context, digest string, size int64, body io.Reader, _ string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.data[digest]; ok {
		return nil
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if int64(len(data)) != size {
		return fmt.Errorf("blob %s: %d bytes, size says %d", digest, len(data), size)
	}
	b.data[digest] = data
	return nil
}

func (b *Blobs) Exists(_ context.Context, digest string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.data[digest]
	return ok, nil
}

func (b *Blobs) Get(_ context.Context, digest string, offset, length int64) (io.ReadCloser, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, ok := b.data[digest]
	if !ok {
		return nil, ports.ErrBlobNotFound
	}
	if offset > int64(len(data)) {
		offset = int64(len(data))
	}
	end := int64(len(data))
	if length > 0 && offset+length < end {
		end = offset + length
	}
	return io.NopCloser(bytes.NewReader(data[offset:end])), nil
}

func (b *Blobs) Presign(_ context.Context, digest, filename string, ttl time.Duration) (string, error) {
	return b.PublicURL + "/" + digest + "?filename=" + filename + "&ttl=" + ttl.String(), nil
}

// Authorizer is an in-memory ports.Authorizer with the model's semantics.
type Authorizer struct {
	mu     sync.Mutex
	tuples map[ports.Tuple]bool
}

// NewAuthorizer returns an empty authorizer.
func NewAuthorizer() *Authorizer { return &Authorizer{tuples: map[ports.Tuple]bool{}} }

func (a *Authorizer) Write(_ context.Context, writes, deletes []ports.Tuple) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range writes {
		a.tuples[t] = true
	}
	for _, t := range deletes {
		delete(a.tuples, t)
	}
	return nil
}

// relationsFor maps a permission to the relations that grant it, weakest first.
var relationsFor = map[string][]string{
	"can_read":    {"viewer", "editor", "owner"},
	"can_write":   {"editor", "owner"},
	"can_share":   {"owner"},
	"can_delete":  {"owner"},
	"can_execute": {"viewer", "editor", "owner"},
	"can_use":     {"user", "viewer", "editor", "owner"},
	"can_run_on":  {"user", "viewer", "editor", "owner"},
	"can_rotate":  {"editor", "owner"},
}

func (a *Authorizer) Check(_ context.Context, subject, permission, object string) (bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	relations, ok := relationsFor[permission]
	if !ok {
		return false, fmt.Errorf("unknown permission %s", permission)
	}
	for _, rel := range relations {
		if a.has(subject, rel, object, 0) {
			return true, nil
		}
	}
	return false, nil
}

// has reports a direct tuple, a wildcard, a group membership, or the relation from a parent.
func (a *Authorizer) has(subject, relation, object string, depth int) bool {
	if depth > 16 {
		return false
	}
	if a.tuples[ports.Tuple{Object: object, Relation: relation, Subject: subject}] {
		return true
	}
	if (relation == "viewer" || relation == "user") && a.tuples[ports.Tuple{Object: object, Relation: relation, Subject: "user:*"}] {
		return true
	}
	for t := range a.tuples {
		if t.Object == object && t.Relation == relation && strings.HasSuffix(t.Subject, "#member") {
			group := strings.TrimSuffix(t.Subject, "#member")
			if a.tuples[ports.Tuple{Object: group, Relation: "member", Subject: subject}] {
				return true
			}
		}
		if t.Object == object && t.Relation == "parent" && a.has(subject, relation, t.Subject, depth+1) {
			return true
		}
	}
	return false
}

// Units is a ports.UnitProvider that answers with the spec's endpoint.
type Units struct{}

func (Units) Endpoint(_ context.Context, spec api.ComputingUnitSpec) (string, error) {
	if spec.Endpoint == nil {
		return "", nil
	}
	return *spec.Endpoint, nil
}

func (Units) Terminate(context.Context, api.ComputingUnitSpec) error { return nil }

// Lineage is a ports.LineageSink that keeps the events.
type Lineage struct {
	mu     sync.Mutex
	Events []json.RawMessage
}

func (l *Lineage) Emit(_ context.Context, event json.RawMessage) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Events = append(l.Events, append(json.RawMessage(nil), event...))
	return nil
}
