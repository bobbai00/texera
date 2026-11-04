// Package openbao is the SecretStore adapter over the Vault HTTP API, KV version 2. It works
// against OpenBao and HashiCorp Vault alike.
package openbao

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/apache/texera/catalog/internal/ports"
)

// Secrets implements ports.SecretStore.
type Secrets struct {
	base   string
	mount  string
	token  string
	client *http.Client
}

// New returns the adapter for the server at base (e.g. http://localhost:18200), the KV v2
// mount and the token.
func New(base, mount, token string) *Secrets {
	return &Secrets{base: strings.TrimSuffix(base, "/"), mount: strings.Trim(mount, "/"), token: token, client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *Secrets) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+"/v1/"+s.mount+path, payload)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("X-Vault-Token", s.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("secret store: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, data, err
}

func clean(path string) string { return "/" + strings.Trim(path, "/") }

// Put writes a new version of the secret.
func (s *Secrets) Put(ctx context.Context, path string, fields map[string]string) error {
	status, body, err := s.do(ctx, http.MethodPost, "/data"+clean(path), map[string]any{"data": fields})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("secret store: put %s: status %d: %s", path, status, truncate(body))
	}
	return nil
}

// Get reads the current version of the secret.
func (s *Secrets) Get(ctx context.Context, path string) (map[string]string, error) {
	status, body, err := s.do(ctx, http.MethodGet, "/data"+clean(path), nil)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, ports.ErrSecretNotFound
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("secret store: get %s: status %d: %s", path, status, truncate(body))
	}
	var resp struct {
		Data struct {
			Data     map[string]string `json:"data"`
			Metadata struct {
				Destroyed bool `json:"destroyed"`
			} `json:"metadata"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("secret store: %w", err)
	}
	if resp.Data.Data == nil || resp.Data.Metadata.Destroyed {
		return nil, ports.ErrSecretNotFound
	}
	return resp.Data.Data, nil
}

// Delete removes the secret and its versions.
func (s *Secrets) Delete(ctx context.Context, path string) error {
	status, body, err := s.do(ctx, http.MethodDelete, "/metadata"+clean(path), nil)
	if err != nil {
		return err
	}
	if status != http.StatusNotFound && (status < 200 || status >= 300) {
		return fmt.Errorf("secret store: delete %s: status %d: %s", path, status, truncate(body))
	}
	return nil
}

func truncate(b []byte) string {
	s := string(b)
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}
