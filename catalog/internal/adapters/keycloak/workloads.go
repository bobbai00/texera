package keycloak

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/apache/texera/catalog/internal/ports"
)

// Workloads: a unit's identity is a confidential client with a service account, made through
// the admin API with the catalog's own token (the service client needs the realm-management
// role manage-clients). The client's secret is what the unit presents; the subject of its
// tokens is the service account user's id, which the lake's grants name.

// CreateWorkload creates the client, replacing one with the same id, and returns its
// credential and subject.
func (id *Identity) CreateWorkload(ctx context.Context, clientID, displayName string) (ports.Workload, error) {
	if err := id.DeleteWorkload(ctx, clientID); err != nil {
		return ports.Workload{}, err
	}
	body := map[string]any{
		"clientId": clientID, "name": displayName, "enabled": true, "protocol": "openid-connect",
		"publicClient": false, "serviceAccountsEnabled": true,
		"standardFlowEnabled": false, "implicitFlowEnabled": false, "directAccessGrantsEnabled": false,
	}
	resp, err := id.admin(ctx, http.MethodPost, "clients", nil, body)
	if err != nil {
		return ports.Workload{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return ports.Workload{}, fmt.Errorf("create client %s: status %d", clientID, resp.StatusCode)
	}
	location := resp.Header.Get("Location")
	internal := location[strings.LastIndex(location, "/")+1:]
	if internal == "" {
		return ports.Workload{}, fmt.Errorf("create client %s: no location", clientID)
	}
	var secret struct {
		Value string `json:"value"`
	}
	if err := id.adminJSON(ctx, "clients/"+internal+"/client-secret", &secret); err != nil {
		return ports.Workload{}, err
	}
	subject, err := id.serviceAccount(ctx, internal)
	if err != nil {
		return ports.Workload{}, err
	}
	return ports.Workload{ClientID: clientID, Secret: secret.Value, Subject: subject}, nil
}

// DeleteWorkload removes the client; a client that does not exist is not an error.
func (id *Identity) DeleteWorkload(ctx context.Context, clientID string) error {
	internal, err := id.clientByID(ctx, clientID)
	if err != nil || internal == "" {
		return err
	}
	resp, err := id.admin(ctx, http.MethodDelete, "clients/"+internal, nil, nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("delete client %s: status %d", clientID, resp.StatusCode)
	}
	return nil
}

// WorkloadSubject returns the subject of the client's tokens.
func (id *Identity) WorkloadSubject(ctx context.Context, clientID string) (string, error) {
	internal, err := id.clientByID(ctx, clientID)
	if err != nil {
		return "", err
	}
	if internal == "" {
		return "", fmt.Errorf("%w: %s", ports.ErrWorkloadNotFound, clientID)
	}
	return id.serviceAccount(ctx, internal)
}

func (id *Identity) serviceAccount(ctx context.Context, internal string) (string, error) {
	var user struct {
		ID string `json:"id"`
	}
	if err := id.adminJSON(ctx, "clients/"+internal+"/service-account-user", &user); err != nil {
		return "", err
	}
	return user.ID, nil
}

// clientByID finds the admin API's id of the client, "" when there is none.
func (id *Identity) clientByID(ctx context.Context, clientID string) (string, error) {
	var found []struct {
		ID       string `json:"id"`
		ClientID string `json:"clientId"`
	}
	if err := id.adminJSON(ctx, "clients?"+url.Values{"clientId": {clientID}}.Encode(), &found); err != nil {
		return "", err
	}
	for _, c := range found {
		if c.ClientID == clientID {
			return c.ID, nil
		}
	}
	return "", nil
}

func (id *Identity) adminJSON(ctx context.Context, path string, out any) error {
	resp, err := id.admin(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("admin %s: status %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// admin sends a request to the realm's admin API with the service token.
func (id *Identity) admin(ctx context.Context, method, path string, _ url.Values, body any) (*http.Response, error) {
	base := adminURL(id.tokenURL)
	if base == "" {
		return nil, fmt.Errorf("no admin API for token URL %s", id.tokenURL)
	}
	token, err := id.ServiceToken(ctx)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+"/"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("admin %s %s: %w", method, path, err)
	}
	return resp, nil
}
