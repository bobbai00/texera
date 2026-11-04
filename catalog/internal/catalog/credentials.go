package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// secretPath is where a credential's value lives in the secret store: the platform's seeds
// name their path in status; everything else is under credentials/{rid}.
func secretPath(r *store.Resource) string {
	var status api.CredentialStatus
	if len(r.Status) > 0 && json.Unmarshal(r.Status, &status) == nil && status.SecretPath != nil && *status.SecretPath != "" {
		return *status.SecretPath
	}
	return "credentials/" + r.RID.String()
}

// SetSecret writes a credential's value; the previous value is replaced.
func (s *Service) SetSecret(ctx context.Context, caller *auth.Caller, rid uuid.UUID, fields map[string]string) error {
	k, _ := kinds.ByName("credential")
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return err
	}
	if err := s.require(ctx, caller, authz.Rotate, rid); err != nil {
		return err
	}
	if len(fields) == 0 {
		return Invalid("the secret needs at least one field", nil)
	}
	if err := s.Secrets.Put(ctx, secretPath(r), fields); err != nil {
		return Unavailable("secret store", err)
	}
	_, err = s.Store.MergeStatus(ctx, rid, mustJSON(map[string]any{"hasSecret": true, "rotatedAt": time.Now().UTC()}))
	return wrap(err, "credential")
}

// Lease hands a credential's value to a run or a turn and logs it.
func (s *Service) Lease(ctx context.Context, caller *auth.Caller, rid uuid.UUID, purpose string) (*api.Lease, error) {
	k, _ := kinds.ByName("credential")
	r, err := s.Get(ctx, caller, &k, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Use, rid); err != nil {
		return nil, err
	}
	if _, err := uri.Parse(purpose); err != nil {
		return nil, Invalid("purpose must be a resource URI: "+err.Error(), nil)
	}
	fields, err := s.Secrets.Get(ctx, secretPath(r))
	if err != nil {
		if errors.Is(err, ports.ErrSecretNotFound) {
			return nil, Conflict("no_secret", "the credential holds no secret yet", nil)
		}
		return nil, Unavailable("secret store", err)
	}
	ttl := s.Config.LeaseTTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	lease, err := s.Store.CreateLease(ctx, rid, caller.PID(), purpose, ttl)
	if err != nil {
		return nil, err
	}
	return &api.Lease{Lease: lease.Lease.String(), Fields: fields, ExpiresAt: lease.ExpiresAt}, nil
}

// refreshSecretStatus records whether a credential's value is present.
func (s *Service) refreshSecretStatus(ctx context.Context, r *store.Resource) {
	_, err := s.Secrets.Get(ctx, secretPath(r))
	has := err == nil
	var status api.CredentialStatus
	_ = json.Unmarshal(r.Status, &status)
	if status.HasSecret != has {
		_, _ = s.Store.MergeStatus(ctx, r.RID, mustJSON(map[string]any{"hasSecret": has}))
	}
}
