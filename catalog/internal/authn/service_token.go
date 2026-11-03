package authn

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ServiceTokenSource obtains client-credentials tokens for the catalog itself (used when it
// calls units and when units report back).
type ServiceTokenSource struct {
	tokenURL     string
	clientID     string
	clientSecret string
	httpClient   *http.Client

	mu     sync.Mutex
	token  string
	expiry time.Time
}

// NewServiceTokenSource uses tokenURL when given and otherwise discovers the token endpoint from
// the issuer's OIDC configuration.
func NewServiceTokenSource(ctx context.Context, discoveryURL, tokenURL, clientID, clientSecret string) (*ServiceTokenSource, error) {
	if tokenURL != "" {
		return &ServiceTokenSource{tokenURL: tokenURL, clientID: clientID, clientSecret: clientSecret, httpClient: http.DefaultClient}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(discoveryURL, "/")+"/.well-known/openid-configuration", nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc configuration: %w", err)
	}
	defer resp.Body.Close()
	var cfg struct {
		TokenEndpoint string `json:"token_endpoint"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil || cfg.TokenEndpoint == "" {
		return nil, fmt.Errorf("oidc configuration: no token_endpoint")
	}
	return &ServiceTokenSource{tokenURL: cfg.TokenEndpoint, clientID: clientID, clientSecret: clientSecret, httpClient: http.DefaultClient}, nil
}

// Token returns a cached token, refreshing it a minute before expiry.
func (s *ServiceTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && time.Until(s.expiry) > time.Minute {
		return s.token, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {s.clientID}, "client_secret": {s.clientSecret}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("service token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("service token: status %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	s.token = body.AccessToken
	s.expiry = time.Now().Add(time.Duration(body.ExpiresIn) * time.Second)
	return s.token, nil
}
