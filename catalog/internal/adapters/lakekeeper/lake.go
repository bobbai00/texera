// Package lakekeeper is the Lake adapter: Lakekeeper's management API for the bootstrap, the
// warehouse, the users and the grants, and its Iceberg REST API for the namespaces. Every call
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
	// Warehouse is the warehouse the units write to; created when missing.
	Warehouse string
	// S3Endpoint is the store's endpoint as Lakekeeper and the units reach it; Bucket and
	// KeyPrefix locate the warehouse in it; the key pair is the warehouse's own.
	S3Endpoint, S3Region, S3Bucket, S3KeyPrefix string
	S3AccessKey, S3SecretKey                    string
	// Tokens mints the catalog's tokens.
	Tokens ports.Identity
}

// Lake implements ports.Lake.
type Lake struct {
	opts Options
	log  *slog.Logger
	http *http.Client

	mu        sync.Mutex
	warehouse string // the warehouse id, the prefix of its Iceberg routes
}

// New returns the adapter; Prepare connects.
func New(opts Options, log *slog.Logger) *Lake {
	return &Lake{opts: opts, log: log, http: &http.Client{Timeout: 60 * time.Second}}
}

// Prepare waits for Lakekeeper, bootstraps it with the catalog as the operator when nobody
// did, and makes sure the warehouse exists with the store's current endpoint and credential
// vending turned on.
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
	return l.ensureWarehouse(ctx)
}

type storageProfile struct {
	Type            string `json:"type"`
	Bucket          string `json:"bucket"`
	KeyPrefix       string `json:"key-prefix"`
	Region          string `json:"region"`
	Endpoint        string `json:"endpoint"`
	PathStyleAccess bool   `json:"path-style-access"`
	Flavor          string `json:"flavor"`
	StsEnabled      bool   `json:"sts-enabled"`
}

func (l *Lake) profile() storageProfile {
	return storageProfile{
		Type: "s3", Bucket: l.opts.S3Bucket, KeyPrefix: l.opts.S3KeyPrefix, Region: l.opts.S3Region,
		Endpoint: l.opts.S3Endpoint, PathStyleAccess: true, Flavor: "s3-compat", StsEnabled: true,
	}
}

func (l *Lake) credential() map[string]any {
	return map[string]any{"type": "s3", "credential-type": "access-key", "aws-access-key-id": l.opts.S3AccessKey, "aws-secret-access-key": l.opts.S3SecretKey}
}

// ensureWarehouse creates the warehouse, or updates its storage when the endpoint or the
// vending changed, and remembers its id.
func (l *Lake) ensureWarehouse(ctx context.Context) error {
	var list struct {
		Warehouses []struct {
			ID      string         `json:"id"`
			Name    string         `json:"name"`
			Profile storageProfile `json:"storage-profile"`
		} `json:"warehouses"`
	}
	if err := l.get(ctx, "/management/v1/warehouse", &list); err != nil {
		return err
	}
	want := l.profile()
	for _, w := range list.Warehouses {
		if w.Name != l.opts.Warehouse {
			continue
		}
		if w.Profile.Endpoint != want.Endpoint || !w.Profile.StsEnabled {
			body := map[string]any{"storage-profile": want, "storage-credential": l.credential()}
			if status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/warehouse/"+w.ID+"/storage", body); err != nil {
				return err
			} else if status/100 != 2 {
				return fmt.Errorf("update warehouse storage: status %d: %s", status, truncate(raw))
			}
			l.log.Info("lakekeeper warehouse storage updated", "warehouse", w.Name, "endpoint", want.Endpoint)
		}
		l.setWarehouse(w.ID)
		return nil
	}
	body := map[string]any{"warehouse-name": l.opts.Warehouse, "storage-profile": want, "storage-credential": l.credential()}
	status, raw, err := l.do(ctx, http.MethodPost, "/management/v1/warehouse", body)
	if err != nil {
		return err
	}
	if status/100 != 2 {
		return fmt.Errorf("create warehouse %s: status %d: %s", l.opts.Warehouse, status, truncate(raw))
	}
	var created struct {
		ID string `json:"warehouse-id"`
	}
	if err := json.Unmarshal(raw, &created); err != nil || created.ID == "" {
		return fmt.Errorf("create warehouse: unexpected answer %s", truncate(raw))
	}
	l.log.Info("lakekeeper warehouse created", "warehouse", l.opts.Warehouse, "id", created.ID)
	l.setWarehouse(created.ID)
	return nil
}

func (l *Lake) setWarehouse(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.warehouse = id
}

func (l *Lake) prefix(ctx context.Context) (string, error) {
	l.mu.Lock()
	id := l.warehouse
	l.mu.Unlock()
	if id != "" {
		return id, nil
	}
	if err := l.ensureWarehouse(ctx); err != nil {
		return "", err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.warehouse, nil
}

// userID is how Lakekeeper names an OIDC subject.
func userID(subject string) string { return "oidc~" + subject }

// OpenNamespace creates the namespace and grants the subject create and modify on it, which
// its tables inherit. Without a subject the namespace is created and nothing is granted.
func (l *Lake) OpenNamespace(ctx context.Context, namespace, subject, name string) error {
	prefix, err := l.prefix(ctx)
	if err != nil {
		return err
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
func (l *Lake) DropNamespace(ctx context.Context, namespace string) error {
	prefix, err := l.prefix(ctx)
	if err != nil {
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
