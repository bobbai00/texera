package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// EnsureBlob records a blob; it reports whether the row is new, so the caller knows whether
// the bytes still need storing.
func (s *Store) EnsureBlob(ctx context.Context, b Blob) (bool, error) {
	tag, err := s.pool.Exec(ctx, `INSERT INTO blob (sha256, size, content_type) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING`, b.SHA256, b.Size, b.ContentType)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// GetBlob returns a blob's row.
func (s *Store) GetBlob(ctx context.Context, sha256 string) (*Blob, error) {
	var b Blob
	err := s.pool.QueryRow(ctx, `SELECT sha256, size, content_type, created_at FROM blob WHERE sha256 = $1`, sha256).Scan(&b.SHA256, &b.Size, &b.ContentType, &b.CreatedAt)
	if err != nil {
		return nil, translate(err)
	}
	return &b, nil
}

// Stage records an uploaded file for the next version.
func (s *Store) Stage(ctx context.Context, f StagedFile) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO dataset_staging (rid, path, sha256, size, content_type) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (rid, path) DO UPDATE SET sha256 = EXCLUDED.sha256, size = EXCLUDED.size, content_type = EXCLUDED.content_type, uploaded_at = now()`,
		f.RID, f.Path, f.SHA256, f.Size, f.ContentType)
	return err
}

// Unstage drops a staged file.
func (s *Store) Unstage(ctx context.Context, rid uuid.UUID, path string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM dataset_staging WHERE rid = $1 AND path = $2`, rid, path)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListStaged returns the staged files of a resource.
func (s *Store) ListStaged(ctx context.Context, rid uuid.UUID) ([]StagedFile, error) {
	rows, err := s.pool.Query(ctx, `SELECT rid, path, sha256, size, content_type, uploaded_at FROM dataset_staging WHERE rid = $1 ORDER BY path`, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (StagedFile, error) {
		var f StagedFile
		err := row.Scan(&f.RID, &f.Path, &f.SHA256, &f.Size, &f.ContentType, &f.UploadedAt)
		return f, err
	})
}
