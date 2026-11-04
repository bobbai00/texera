package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CreateLease records that a credential's secret was handed out.
func (s *Store) CreateLease(ctx context.Context, credential, pid uuid.UUID, purpose string, ttl time.Duration) (*Lease, error) {
	var l Lease
	err := s.pool.QueryRow(ctx, `INSERT INTO credential_lease (credential_rid, pid, purpose, expires_at) VALUES ($1, $2, $3, now() + $4::interval)
		RETURNING lease, credential_rid, pid, purpose, created_at, expires_at, revoked_at`, credential, pid, purpose, ttl.String()).
		Scan(&l.Lease, &l.CredentialRID, &l.PID, &l.Purpose, &l.CreatedAt, &l.ExpiresAt, &l.RevokedAt)
	if err != nil {
		return nil, err
	}
	return &l, nil
}

// ListLeases returns a credential's leases, newest first.
func (s *Store) ListLeases(ctx context.Context, credential uuid.UUID, limit int) ([]Lease, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT lease, credential_rid, pid, purpose, created_at, expires_at, revoked_at FROM credential_lease
		WHERE credential_rid = $1 ORDER BY created_at DESC LIMIT $2`, credential, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Lease, error) {
		var l Lease
		err := row.Scan(&l.Lease, &l.CredentialRID, &l.PID, &l.Purpose, &l.CreatedAt, &l.ExpiresAt, &l.RevokedAt)
		return l, err
	})
}

// AddLineageEvent stores a raw OpenLineage event.
func (s *Store) AddLineageEvent(ctx context.Context, execution *uuid.UUID, body json.RawMessage) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `INSERT INTO lineage_event (execution_rid, body) VALUES ($1, $2) RETURNING id`, execution, body).Scan(&id)
	return id, err
}

// LineageEvents returns the raw events of an execution, oldest first.
func (s *Store) LineageEvents(ctx context.Context, execution uuid.UUID) ([]json.RawMessage, error) {
	rows, err := s.pool.Query(ctx, `SELECT body FROM lineage_event WHERE execution_rid = $1 ORDER BY id`, execution)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (json.RawMessage, error) {
		var b []byte
		err := row.Scan(&b)
		return json.RawMessage(b), err
	})
}
