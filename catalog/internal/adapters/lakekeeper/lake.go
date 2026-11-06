// Package lakekeeper is the Lake adapter: Lakekeeper's management API for the bootstrap, the
// warehouses, the users and the grants, and its Iceberg REST API for the namespaces. Every call
// carries the catalog's own token; the first one bootstraps the server with the catalog as its
// operator, so the catalog may create warehouses and namespaces and hand out grants on them.
package lakekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/apache/texera/catalog/internal/ports"
)

// Options configure the adapter.
type Options struct {
	// URL is Lakekeeper's base URL as the catalog reaches it.
	URL string
	// Tokens mints the catalog's tokens.
	Tokens ports.Identity
}

// Lake implements ports.Lake.
type Lake struct {
	opts Options
	log  *slog.Logger
	http *http.Client

	mu  sync.Mutex
	ids map[string]string // a warehouse's id by its name: the prefix of its Iceberg routes

	// How long a warehouse that is being emptied is waited for, and how often it is asked.
	clearing, pause time.Duration
}

// New returns the adapter; Prepare connects.
func New(opts Options, log *slog.Logger) *Lake {
	return &Lake{opts: opts, log: log, http: &http.Client{Timeout: 60 * time.Second}, ids: map[string]string{}, clearing: 30 * time.Second, pause: time.Second}
}

// Prepare waits for Lakekeeper and bootstraps it with the catalog as the operator when nobody
// did. The warehouses are the catalog's resources: it makes each one with EnsureWarehouse.
func (l *Lake) Prepare(ctx context.Context) error {
	var info struct {
		Bootstrapped bool `json:"bootstrapped"`
	}
	deadline := time.Now().Add(3 * time.Minute)
	for {
		err := l.get(ctx, "/management/v1/info", &info)
		if err == nil || time.Now().After(deadline) {
			if err != nil {
				return fmt.Errorf("lakekeeper at %s: %w", l.opts.URL, err)
			}
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	if !info.Bootstrapped {
		body := map[string]any{"accept-terms-of-use": true, "is-operator": true}
		if status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/bootstrap", body); err != nil {
			return err
		} else if status != http.StatusNoContent && status != http.StatusOK && !strings.Contains(string(raw), "Bootstrapped") {
			return fmt.Errorf("bootstrap: status %d: %s", status, truncate(raw))
		}
		l.log.Info("lakekeeper bootstrapped")
	}
	if status, _, err := l.do(ctx, http.MethodGet, "/management/v1/project", nil); err != nil {
		return err
	} else if status == http.StatusNotFound {
		body := map[string]any{"project-id": "00000000-0000-0000-0000-000000000000", "project-name": "default"}
		if status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/project", body); err != nil {
			return err
		} else if status/100 != 2 {
			return fmt.Errorf("create project: status %d: %s", status, truncate(raw))
		}
	}
	return nil
}

type storageProfile struct {
	Type            string `json:"type"`
	Bucket          string `json:"bucket"`
	KeyPrefix       string `json:"key-prefix,omitempty"`
	Region          string `json:"region"`
	Endpoint        string `json:"endpoint"`
	PathStyleAccess bool   `json:"path-style-access"`
	Flavor          string `json:"flavor"`
	StsEnabled      bool   `json:"sts-enabled"`
}

// profileOf is a storage as Lakekeeper takes it: an S3-compatible store reached by path, with
// credential vending on, so a unit never holds a key to the whole warehouse.
func profileOf(storage ports.WarehouseStorage) storageProfile {
	return storageProfile{
		Type: "s3", Bucket: storage.Bucket, KeyPrefix: storage.KeyPrefix, Region: storage.Region,
		Endpoint: storage.Endpoint, PathStyleAccess: true, Flavor: "s3-compat", StsEnabled: true,
	}
}

// samePlace reports whether two profiles are one place. Lakekeeper writes an endpoint back with
// a slash at its end.
func (p storageProfile) samePlace(o storageProfile) bool {
	p.Endpoint, o.Endpoint = strings.TrimRight(p.Endpoint, "/"), strings.TrimRight(o.Endpoint, "/")
	p.KeyPrefix, o.KeyPrefix = strings.Trim(p.KeyPrefix, "/"), strings.Trim(o.KeyPrefix, "/")
	return p == o
}

func credentialOf(storage ports.WarehouseStorage) map[string]any {
	return map[string]any{"type": "s3", "credential-type": "access-key", "aws-access-key-id": storage.AccessKey, "aws-secret-access-key": storage.SecretKey}
}

type warehouseEntry struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Profile storageProfile `json:"storage-profile"`
}

// find returns the warehouse of a name, nil when the lake has none.
func (l *Lake) find(ctx context.Context, warehouse string) (*warehouseEntry, error) {
	var list struct {
		Warehouses []warehouseEntry `json:"warehouses"`
	}
	if err := l.get(ctx, "/management/v1/warehouse", &list); err != nil {
		return nil, err
	}
	for i := range list.Warehouses {
		if list.Warehouses[i].Name == warehouse {
			l.remember(warehouse, list.Warehouses[i].ID)
			return &list.Warehouses[i], nil
		}
	}
	return nil, nil
}

// EnsureWarehouse creates the warehouse, or brings its storage and its key up to date.
// Lakekeeper tries a storage before it takes it; what it answers then is the refusal's reason.
func (l *Lake) EnsureWarehouse(ctx context.Context, warehouse string, storage ports.WarehouseStorage) error {
	found, err := l.find(ctx, warehouse)
	if err != nil {
		return err
	}
	want := profileOf(storage)
	if found == nil {
		body := map[string]any{"warehouse-name": warehouse, "storage-profile": want, "storage-credential": credentialOf(storage)}
		status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/warehouse", body)
		if err != nil {
			return err
		}
		if status/100 == 4 {
			return fmt.Errorf("%w: %s", ports.ErrStorageRefused, reason(raw))
		}
		if status/100 != 2 {
			return fmt.Errorf("create warehouse %s: status %d: %s", warehouse, status, truncate(raw))
		}
		var created struct {
			ID string `json:"warehouse-id"`
		}
		if err := json.Unmarshal(raw, &created); err == nil && created.ID != "" {
			l.remember(warehouse, created.ID)
		}
		l.log.Info("lakekeeper warehouse created", "warehouse", warehouse, "id", created.ID)
		return nil
	}
	// The same place: only the key may have changed. Another place: the storage with its key.
	path, body := "/storage-credential", map[string]any{"new-storage-credential": credentialOf(storage)}
	if !found.Profile.samePlace(want) {
		path, body = "/storage", map[string]any{"storage-profile": want, "storage-credential": credentialOf(storage)}
	}
	status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/warehouse/"+found.ID+path, body)
	if err != nil {
		return err
	}
	if status/100 == 4 {
		return fmt.Errorf("%w: %s", ports.ErrStorageRefused, reason(raw))
	}
	if status/100 != 2 {
		return fmt.Errorf("update warehouse %s: status %d: %s", warehouse, status, truncate(raw))
	}
	return nil
}

// RemoveWarehouse deletes the warehouse. Lakekeeper refuses while it holds a namespace. Once
// the last one is dropped it clears the files of the dropped tables, for some seconds, and
// refuses until it is done: that is waited for here, since nothing is kept there any more.
func (l *Lake) RemoveWarehouse(ctx context.Context, warehouse string) error {
	found, err := l.find(ctx, warehouse)
	if err != nil || found == nil {
		return err
	}
	deadline := time.Now().Add(l.clearing)
	for {
		status, raw, err := l.do(ctx, http.MethodDelete, "/management/v1/warehouse/"+found.ID, nil)
		if err != nil {
			return err
		}
		message, kind := answerOf(raw)
		switch {
		case status/100 == 2 || status == http.StatusNotFound:
			l.mu.Lock()
			delete(l.ids, warehouse)
			l.mu.Unlock()
			return nil
		case status == http.StatusConflict && kind == "WarehouseHasUnfinishedTasks" && time.Now().Before(deadline):
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(l.pause):
			}
		case status == http.StatusConflict || status == http.StatusBadRequest:
			return fmt.Errorf("%w: %s", ports.ErrWarehouseNotEmpty, message)
		default:
			return fmt.Errorf("delete warehouse %s: status %d: %s", warehouse, status, truncate(raw))
		}
	}
}

func (l *Lake) remember(warehouse, id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ids[warehouse] = id
}

// prefix is a warehouse's id, which its Iceberg routes start with; "" when the lake has no
// warehouse of the name.
func (l *Lake) prefix(ctx context.Context, warehouse string) (string, error) {
	l.mu.Lock()
	id := l.ids[warehouse]
	l.mu.Unlock()
	if id != "" {
		return id, nil
	}
	found, err := l.find(ctx, warehouse)
	if err != nil || found == nil {
		return "", err
	}
	return found.ID, nil
}

// answerOf is what Lakekeeper said in an error answer, and the kind of error it named.
func answerOf(raw []byte) (message, kind string) {
	var answer struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &answer); err == nil && answer.Error.Message != "" {
		return answer.Error.Message, answer.Error.Type
	}
	return truncate(raw), ""
}

// reason is what Lakekeeper said in an error answer.
func reason(raw []byte) string {
	message, _ := answerOf(raw)
	return message
}

// userID is how Lakekeeper names an OIDC subject.
func userID(subject string) string { return "oidc~" + subject }

// OpenNamespace creates the namespace and grants the subject create and modify on it, which
// its tables inherit. Without a subject the namespace is created and nothing is granted.
func (l *Lake) OpenNamespace(ctx context.Context, warehouse, namespace, subject, name string) error {
	prefix, err := l.prefix(ctx, warehouse)
	if err != nil {
		return err
	}
	if prefix == "" {
		return fmt.Errorf("the lake has no warehouse %s", warehouse)
	}
	body := map[string]any{"namespace": []string{namespace}, "properties": map[string]string{}}
	status, raw, err := l.do(ctx, http.MethodPost, "/catalog/v1/"+prefix+"/namespaces", body)
	if err != nil {
		return err
	}
	if status/100 != 2 && status != http.StatusConflict {
		return fmt.Errorf("create namespace %s: status %d: %s", namespace, status, truncate(raw))
	}
	if subject == "" {
		return nil
	}
	user := map[string]any{"id": userID(subject), "name": name, "user-type": "application", "update-if-exists": true}
	if status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/user", user); err != nil {
		return err
	} else if status/100 != 2 {
		return fmt.Errorf("register user %s: status %d: %s", name, status, truncate(raw))
	}
	var ns struct {
		UUID string `json:"namespace-uuid"`
	}
	if err := l.get(ctx, "/catalog/v1/"+prefix+"/namespaces/"+url.PathEscape(namespace)+"?returnUuid=true", &ns); err != nil {
		return err
	}
	if ns.UUID == "" {
		return fmt.Errorf("namespace %s: no uuid in the answer", namespace)
	}
	var current struct {
		Assignments []struct {
			Type string `json:"type"`
			User string `json:"user"`
		} `json:"assignments"`
	}
	if err := l.get(ctx, "/management/v1/permissions/namespace/"+ns.UUID+"/assignments", &current); err != nil {
		return err
	}
	held := map[string]bool{}
	for _, a := range current.Assignments {
		if a.User == userID(subject) {
			held[a.Type] = true
		}
	}
	var writes []map[string]string
	for _, relation := range []string{"create", "modify"} {
		if !held[relation] {
			writes = append(writes, map[string]string{"type": relation, "user": userID(subject)})
		}
	}
	if len(writes) == 0 {
		return nil
	}
	if status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/permissions/namespace/"+ns.UUID+"/assignments", map[string]any{"writes": writes}); err != nil {
		return err
	} else if status/100 != 2 {
		return fmt.Errorf("grant %s on %s: status %d: %s", name, namespace, status, truncate(raw))
	}
	return nil
}

// DropNamespace drops the namespace with its tables and their data.
func (l *Lake) DropNamespace(ctx context.Context, warehouse, namespace string) error {
	prefix, err := l.prefix(ctx, warehouse)
	if err != nil || prefix == "" {
		return err
	}
	status, raw, err := l.do(ctx, http.MethodDelete, "/catalog/v1/"+prefix+"/namespaces/"+url.PathEscape(namespace)+"?recursive=true&force=true&purge=true", nil)
	if err != nil {
		return err
	}
	if status/100 != 2 && status != http.StatusNotFound {
		return fmt.Errorf("drop namespace %s: status %d: %s", namespace, status, truncate(raw))
	}
	return nil
}

func (l *Lake) get(ctx context.Context, path string, out any) error {
	status, raw, err := l.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("GET %s: status %d: %s", path, status, truncate(raw))
	}
	return json.Unmarshal(raw, out)
}

// do sends a request with the catalog's token and returns the status and the body.
func (l *Lake) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	token, err := l.opts.Tokens.ServiceToken(ctx)
	if err != nil {
		return 0, nil, err
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(l.opts.URL, "/")+path, reader)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := l.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("lakekeeper %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, raw, nil
}

func truncate(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}
