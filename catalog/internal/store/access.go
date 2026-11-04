package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func object(rid uuid.UUID) string { return "resource:" + rid.String() }

// subjectOf renders a principal as an OpenFGA subject: user:<pid> or group:<pid>#member.
func subjectOf(ctx context.Context, tx pgx.Tx, pid uuid.UUID) string {
	var kind string
	if err := tx.QueryRow(ctx, `SELECT kind FROM principal WHERE pid = $1`, pid).Scan(&kind); err == nil && kind == "group" {
		return "group:" + pid.String() + "#member"
	}
	return "user:" + pid.String()
}

func enqueue(ctx context.Context, tx pgx.Tx, op, object, relation, subject string) error {
	_, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ($1, $2, $3, $4)`, op, object, relation, subject)
	return err
}

// SetEveryone grants or revokes a relation to everyone (`user:*`) on a resource, outside the
// grant index: the way the system project makes the platform's unit, credentials and model
// endpoint usable by all. The write is idempotent; the rebuild derives it from the label.
func (s *Store) SetEveryone(ctx context.Context, rid uuid.UUID, relation string, on bool) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		op := "write"
		if !on {
			op = "delete"
		}
		return enqueue(ctx, tx, op, object(rid), relation, "user:*")
	})
}

// writeGrant records a direct relation: one per principal and resource, so a change of
// relation deletes the old tuple.
func writeGrant(ctx context.Context, tx pgx.Tx, rid, pid uuid.UUID, relation string) error {
	var previous string
	err := tx.QueryRow(ctx, `SELECT relation FROM access_index WHERE rid = $1 AND pid = $2`, rid, pid).Scan(&previous)
	subject := subjectOf(ctx, tx, pid)
	switch {
	case err == nil && previous == relation:
		return nil
	case err == nil:
		if err := enqueue(ctx, tx, "delete", object(rid), previous, subject); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE access_index SET relation = $3, created_at = now() WHERE rid = $1 AND pid = $2`, rid, pid, relation); err != nil {
			return err
		}
	case err == pgx.ErrNoRows:
		if _, err := tx.Exec(ctx, `INSERT INTO access_index (rid, pid, relation) VALUES ($1, $2, $3)`, rid, pid, relation); err != nil {
			return err
		}
	default:
		return err
	}
	return enqueue(ctx, tx, "write", object(rid), relation, subject)
}

// Grant gives a principal a relation on a resource.
func (s *Store) Grant(ctx context.Context, rid, pid uuid.UUID, relation string) (*Grant, error) {
	var g Grant
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if err := writeGrant(ctx, tx, rid, pid, relation); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT rid, pid, relation, created_at FROM access_index WHERE rid = $1 AND pid = $2`, rid, pid).
			Scan(&g.RID, &g.PID, &g.Relation, &g.CreatedAt)
	})
	if err != nil {
		return nil, translate(err)
	}
	return &g, nil
}

// Revoke removes a principal's relation on a resource.
func (s *Store) Revoke(ctx context.Context, rid, pid uuid.UUID) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		var relation string
		if err := tx.QueryRow(ctx, `DELETE FROM access_index WHERE rid = $1 AND pid = $2 RETURNING relation`, rid, pid).Scan(&relation); err != nil {
			return translate(err)
		}
		return enqueue(ctx, tx, "delete", object(rid), relation, subjectOf(ctx, tx, pid))
	})
}

// ListGrants returns the direct grants on a resource.
func (s *Store) ListGrants(ctx context.Context, rid uuid.UUID) ([]Grant, error) {
	rows, err := s.pool.Query(ctx, `SELECT rid, pid, relation, created_at FROM access_index WHERE rid = $1 ORDER BY created_at`, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Grant, error) {
		var g Grant
		err := row.Scan(&g.RID, &g.PID, &g.Relation, &g.CreatedAt)
		return g, err
	})
}

// DirectRelation returns the principal's direct relation on a resource, "" when none.
func (s *Store) DirectRelation(ctx context.Context, rid, pid uuid.UUID) (string, error) {
	var relation string
	err := s.pool.QueryRow(ctx, `SELECT relation FROM access_index WHERE rid = $1 AND pid = $2`, rid, pid).Scan(&relation)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return relation, err
}

// EnqueueTuple records a tuple write or delete for the relay outside a resource transaction
// (group memberships).
func (s *Store) EnqueueTuple(ctx context.Context, op, object, relation, subject string) error {
	return s.tx(ctx, func(tx pgx.Tx) error { return enqueue(ctx, tx, op, object, relation, subject) })
}

// PendingOutbox returns unprocessed entries, oldest first.
func (s *Store) PendingOutbox(ctx context.Context, limit int) ([]OutboxEntry, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, op, object, relation, subject FROM access_outbox WHERE processed_at IS NULL ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (OutboxEntry, error) {
		var e OutboxEntry
		err := row.Scan(&e.ID, &e.Op, &e.Object, &e.Relation, &e.Subject)
		return e, err
	})
}

// MarkOutboxProcessed marks entries done.
func (s *Store) MarkOutboxProcessed(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE access_outbox SET processed_at = now() WHERE id = ANY($1)`, ids)
	return err
}

// AllTuples lists every tuple the index implies, for a rebuild of the authorization store:
// direct grants, parent links, public viewers and the system project's users.
func (s *Store) AllTuples(ctx context.Context) ([]OutboxEntry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT 'resource:' || a.rid, a.relation, CASE p.kind WHEN 'group' THEN 'group:' || a.pid || '#member' ELSE 'user:' || a.pid END
		FROM access_index a JOIN principal p ON p.pid = a.pid JOIN resource r ON r.rid = a.rid WHERE r.deleted_at IS NULL
		UNION ALL
		SELECT 'resource:' || r.rid, 'parent', 'resource:' || r.parent_rid FROM resource r WHERE r.parent_rid IS NOT NULL AND r.deleted_at IS NULL
		UNION ALL
		SELECT 'resource:' || r.rid, 'viewer', 'user:*' FROM resource r WHERE r.visibility = 'public' AND r.deleted_at IS NULL
		UNION ALL
		SELECT 'resource:' || r.rid, 'user', 'user:*' FROM resource r WHERE r.kind = 'project' AND r.labels->>'texera.system' = 'true' AND r.deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxEntry
	for rows.Next() {
		var e OutboxEntry
		if err := rows.Scan(&e.Object, &e.Relation, &e.Subject); err != nil {
			return nil, err
		}
		e.Op = "write"
		out = append(out, e)
	}
	return out, rows.Err()
}

// ErrBadRelation is returned for a relation outside the model.
var ErrBadRelation = fmt.Errorf("relation must be owner, editor, viewer or user")

// ValidRelation reports whether a relation is grantable.
func ValidRelation(relation string) bool {
	switch relation {
	case "owner", "editor", "viewer", "user":
		return true
	}
	return false
}
