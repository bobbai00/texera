// Package memory holds in-memory adapters for tests: a secret store, a blob store, an
// authorizer with the model's semantics (relation hierarchy, parent inheritance, the public
// wildcard, group membership), a unit provider, unit identities and a lake.
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

func (b *Blobs) Delete(_ context.Context, digest string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.data, digest)
	return nil
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
	"can_use":     {"user", "editor", "owner"},
	"can_run_on":  {"user", "editor", "owner"},
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

func (Units) Endpoint(_ context.Context, _ string, spec api.ComputingUnitSpec, _ ports.WorkloadSource) (string, error) {
	if spec.Endpoint == nil {
		return "", nil
	}
	return *spec.Endpoint, nil
}

func (Units) Terminate(context.Context, string, api.ComputingUnitSpec) error { return nil }

func (Units) Offers(context.Context, api.ComputingUnitSpec) error { return nil }

// Workloads is a ports.Workloads that mints predictable identities: the subject of client c
// is "sa:" + c and its secret "secret-" + c. It starts with the dev stack's unit client.
type Workloads struct {
	mu      sync.Mutex
	clients map[string]ports.Workload
}

// NewWorkloads returns a provider that knows the dev stack's static unit client.
func NewWorkloads() *Workloads {
	w := &Workloads{clients: map[string]ports.Workload{}}
	w.clients["texera-unit"] = workload("texera-unit")
	return w
}

func workload(clientID string) ports.Workload {
	return ports.Workload{ClientID: clientID, Secret: "secret-" + clientID, Subject: "sa:" + clientID}
}

func (w *Workloads) CreateWorkload(_ context.Context, clientID, _ string) (ports.Workload, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.clients[clientID] = workload(clientID)
	return w.clients[clientID], nil
}

func (w *Workloads) DeleteWorkload(_ context.Context, clientID string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.clients, clientID)
	return nil
}

func (w *Workloads) WorkloadSubject(_ context.Context, clientID string) (string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	c, ok := w.clients[clientID]
	if !ok {
		return "", ports.ErrWorkloadNotFound
	}
	return c.Subject, nil
}

// Has reports whether the client exists.
func (w *Workloads) Has(clientID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.clients[clientID]
	return ok
}

// Lake is a ports.Lake that remembers the warehouses it was given, and which namespaces were
// opened in them for whom and dropped. A namespace is kept as "warehouse/namespace".
type Lake struct {
	mu         sync.Mutex
	Warehouses map[string]ports.WarehouseStorage
	Opened     map[string]string
	Dropped    []string
	// Refuse, when set, is asked about a storage before it is taken: a reason refuses it.
	Refuse func(ports.WarehouseStorage) string
}

// NewLake returns an empty lake.
func NewLake() *Lake {
	return &Lake{Warehouses: map[string]ports.WarehouseStorage{}, Opened: map[string]string{}}
}

func (l *Lake) Prepare(context.Context) error { return nil }

func (l *Lake) EnsureWarehouse(_ context.Context, warehouse string, storage ports.WarehouseStorage) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.Refuse != nil {
		if reason := l.Refuse(storage); reason != "" {
			return fmt.Errorf("%w: %s", ports.ErrStorageRefused, reason)
		}
	}
	l.Warehouses[warehouse] = storage
	return nil
}

func (l *Lake) RemoveWarehouse(_ context.Context, warehouse string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key := range l.Opened {
		if strings.HasPrefix(key, warehouse+"/") {
			return ports.ErrWarehouseNotEmpty
		}
	}
	delete(l.Warehouses, warehouse)
	return nil
}

func (l *Lake) OpenNamespace(_ context.Context, warehouse, namespace, subject, _ string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.Warehouses[warehouse]; !ok {
		return fmt.Errorf("no warehouse %s", warehouse)
	}
	l.Opened[warehouse+"/"+namespace] = subject
	return nil
}

func (l *Lake) DropNamespace(_ context.Context, warehouse, namespace string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.Opened, warehouse+"/"+namespace)
	l.Dropped = append(l.Dropped, warehouse+"/"+namespace)
	return nil
}

// OpenedFor returns the subject a namespace of a warehouse was opened for, "" when it was not.
func (l *Lake) OpenedFor(warehouse, namespace string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.Opened[warehouse+"/"+namespace]
}

// Storage returns the storage a warehouse was given, and whether the lake has the warehouse.
func (l *Lake) Storage(warehouse string) (ports.WarehouseStorage, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	storage, ok := l.Warehouses[warehouse]
	return storage, ok
}

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
