package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ListGrants returns the grants on a resource.
func (s *Store) ListGrants(ctx context.Context, rid uuid.UUID) ([]Grant, error) {
	rows, err := s.pool.Query(ctx, `SELECT rid, pid, relation, created_at FROM access_grant WHERE rid = $1 ORDER BY created_at`, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.RID, &g.PID, &g.Relation, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// PutGrant upserts a grant and queues the OpenFGA tuple change.
func (s *Store) PutGrant(ctx context.Context, rid, pid uuid.UUID, relation string) (*Grant, error) {
	var out Grant
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		r, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource WHERE rid = $1 AND deleted_at IS NULL`, rid))
		if err != nil {
			return err
		}
		var old *string
		if err := tx.QueryRow(ctx, `SELECT relation FROM access_grant WHERE rid = $1 AND pid = $2`, rid, pid).Scan(&old); err != nil && err != pgx.ErrNoRows {
			return err
		}
		if old != nil && *old != relation {
			if err := enqueueTuple(ctx, tx, "delete", r, pid, *old); err != nil {
				return err
			}
		}
		if err := tx.QueryRow(ctx, `INSERT INTO access_grant (rid, pid, relation) VALUES ($1, $2, $3)
			ON CONFLICT (rid, pid) DO UPDATE SET relation = EXCLUDED.relation RETURNING rid, pid, relation, created_at`,
			rid, pid, relation).Scan(&out.RID, &out.PID, &out.Relation, &out.CreatedAt); err != nil {
			return err
		}
		if old == nil || *old != relation {
			return enqueueTuple(ctx, tx, "write", r, pid, relation)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteGrant removes a grant and queues the tuple deletion.
func (s *Store) DeleteGrant(ctx context.Context, rid, pid uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		r, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource WHERE rid = $1 AND deleted_at IS NULL`, rid))
		if err != nil {
			return err
		}
		var relation string
		if err := tx.QueryRow(ctx, `DELETE FROM access_grant WHERE rid = $1 AND pid = $2 RETURNING relation`, rid, pid).Scan(&relation); err != nil {
			return notFound(err)
		}
		return enqueueTuple(ctx, tx, "delete", r, pid, relation)
	})
}

// HasRelation reports whether the principal holds at least the given relation on the
// resource directly, through ownership, or through a parent project. It is the catalog's
// own view of the grants and is used when the PDP is unavailable or for listings.
func (s *Store) HasRelation(ctx context.Context, rid, pid uuid.UUID, relation string) (bool, error) {
	rank := map[string]int{"viewer": 1, "editor": 2, "owner": 3}
	need := rank[relation]
	var ok bool
	err := s.pool.QueryRow(ctx, `WITH RECURSIVE chain AS (
			SELECT rid, parent_rid, visibility, owner_pid, 0 AS depth FROM resource WHERE rid = $1
			UNION ALL
			SELECT r.rid, r.parent_rid, r.visibility, r.owner_pid, c.depth + 1 FROM resource r JOIN chain c ON r.rid = c.parent_rid WHERE c.depth < 32
		)
		SELECT EXISTS (
			SELECT 1 FROM chain c LEFT JOIN access_grant g ON g.rid = c.rid AND g.pid = $2
			WHERE c.owner_pid = $2
			   OR (g.relation = 'owner') OR (g.relation = 'editor' AND $3 <= 2) OR (g.relation = 'viewer' AND $3 <= 1)
			   OR (c.visibility = 'public' AND $3 <= 1)
		)`, rid, pid, need).Scan(&ok)
	return ok, err
}

// PendingOutbox returns unprocessed tuple changes in order.
func (s *Store) PendingOutbox(ctx context.Context, limit int) ([]OutboxEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, op, object, relation, subject FROM access_outbox WHERE processed_at IS NULL ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxEntry
	for rows.Next() {
		var e OutboxEntry
		if err := rows.Scan(&e.ID, &e.Op, &e.Object, &e.Relation, &e.Subject); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkOutboxProcessed marks entries done.
func (s *Store) MarkOutboxProcessed(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE access_outbox SET processed_at = now() WHERE id = ANY($1)`, ids)
	return err
}
