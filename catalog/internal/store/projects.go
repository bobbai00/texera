package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Chain returns a project and what it inherits from, nearest first: the project, its base, that
// one's base, and so on to the project with no base, Texera. A chain that loops (which the
// catalog refuses to make) ends where it would repeat.
func (s *Store) Chain(ctx context.Context, project uuid.UUID) ([]Resource, error) {
	rows, err := s.pool.Query(ctx, `
		WITH RECURSIVE chain(rid, depth, path) AS (
			SELECT r.rid, 0, ARRAY[r.rid] FROM resource r WHERE r.rid = $1 AND r.deleted_at IS NULL
			UNION ALL
			SELECT b.rid, c.depth + 1, c.path || b.rid
			FROM chain c JOIN resource p ON p.rid = c.rid JOIN resource b ON b.rid = p.base_rid
			WHERE b.deleted_at IS NULL AND NOT b.rid = ANY(c.path) AND c.depth < 64)
		SELECT `+resourceColumns+` FROM chain c JOIN resource r ON r.rid = c.rid ORDER BY c.depth`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Resource
	for rows.Next() {
		r, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// Inheritors returns the live projects whose base is the given project.
func (s *Store) Inheritors(ctx context.Context, base uuid.UUID, limit int) ([]Resource, error) {
	return s.ListResources(ctx, ResourceFilter{Kind: "project", BaseRID: &base, Limit: limit})
}

// OfferedOperatorTypes returns which of the operator types a resource of kind operator in one
// of the projects stands for: what those projects offer a workflow.
func (s *Store) OfferedOperatorTypes(ctx context.Context, projects []uuid.UUID, types []string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT spec ->> 'operatorType' FROM resource
		WHERE kind = 'operator' AND deleted_at IS NULL AND project_rid = ANY($1) AND spec ->> 'operatorType' = ANY($2)`, projects, types)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out[t] = true
	}
	return out, rows.Err()
}

// Shipped is what a release put into Texera under a name: the resource, and the digest of the
// spec the release last wrote to it.
type Shipped struct {
	Kind, Name string
	RID        uuid.UUID
	Digest     string
}

// GetShipped returns what was shipped of a kind under a name.
func (s *Store) GetShipped(ctx context.Context, kind, name string) (*Shipped, error) {
	var sh Shipped
	err := s.pool.QueryRow(ctx, `SELECT kind, name, rid, digest FROM shipped WHERE kind = $1 AND name = $2`, kind, name).
		Scan(&sh.Kind, &sh.Name, &sh.RID, &sh.Digest)
	if err == pgx.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sh, nil
}

// ListShipped returns what was shipped of a kind.
func (s *Store) ListShipped(ctx context.Context, kind string) ([]Shipped, error) {
	rows, err := s.pool.Query(ctx, `SELECT kind, name, rid, digest FROM shipped WHERE kind = $1 ORDER BY name`, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Shipped, error) {
		var sh Shipped
		err := row.Scan(&sh.Kind, &sh.Name, &sh.RID, &sh.Digest)
		return sh, err
	})
}

// RecordShipped records what a release wrote of a kind under a name.
func (s *Store) RecordShipped(ctx context.Context, sh Shipped) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO shipped (kind, name, rid, digest) VALUES ($1, $2, $3, $4)
		ON CONFLICT (kind, name) DO UPDATE SET rid = EXCLUDED.rid, digest = EXCLUDED.digest`, sh.Kind, sh.Name, sh.RID, sh.Digest)
	return err
}

// ForgetShipped drops the record of what was shipped of a kind under a name.
func (s *Store) ForgetShipped(ctx context.Context, kind, name string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM shipped WHERE kind = $1 AND name = $2`, kind, name)
	return err
}
