package store

import (
	"context"

	"github.com/google/uuid"
)

// UpsertStagedFile records an uploaded, uncommitted dataset file.
func (s *Store) UpsertStagedFile(ctx context.Context, f StagedFile) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO dataset_staging (rid, path, size, sha256, content_type, object_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (rid, path) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, content_type = EXCLUDED.content_type,
			object_key = EXCLUDED.object_key, uploaded_at = now()`,
		f.RID, f.Path, f.Size, f.SHA256, f.ContentType, f.ObjectKey)
	return err
}

// DeleteStagedFile removes a staged file record.
func (s *Store) DeleteStagedFile(ctx context.Context, rid uuid.UUID, path string) (*StagedFile, error) {
	var f StagedFile
	if err := s.pool.QueryRow(ctx, `DELETE FROM dataset_staging WHERE rid = $1 AND path = $2 RETURNING rid, path, size, sha256, content_type, object_key, uploaded_at`, rid, path).
		Scan(&f.RID, &f.Path, &f.Size, &f.SHA256, &f.ContentType, &f.ObjectKey, &f.UploadedAt); err != nil {
		return nil, notFound(err)
	}
	return &f, nil
}

// ListStagedFiles returns the staged files of a dataset.
func (s *Store) ListStagedFiles(ctx context.Context, rid uuid.UUID) ([]StagedFile, error) {
	rows, err := s.pool.Query(ctx, `SELECT rid, path, size, sha256, content_type, object_key, uploaded_at FROM dataset_staging WHERE rid = $1 ORDER BY path`, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StagedFile
	for rows.Next() {
		var f StagedFile
		if err := rows.Scan(&f.RID, &f.Path, &f.Size, &f.SHA256, &f.ContentType, &f.ObjectKey, &f.UploadedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ClearStagedFiles removes all staged records of a dataset (after a commit).
func (s *Store) ClearStagedFiles(ctx context.Context, rid uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM dataset_staging WHERE rid = $1`, rid)
	return err
}
