package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// LiveState is the live document of a resource: what the live service keeps between
// sessions, as it encoded it, with the version the document was last saved as.
type LiveState struct {
	RID       uuid.UUID
	BasedOn   *int
	State     []byte
	UpdatedAt time.Time
}

// GetLiveState returns the live document of a resource that exists; ErrNotFound when it has
// none.
func (s *Store) GetLiveState(ctx context.Context, rid uuid.UUID) (*LiveState, error) {
	l := LiveState{RID: rid}
	err := s.pool.QueryRow(ctx, `SELECT l.based_on, l.state, l.updated_at
		FROM live_state l JOIN resource r ON r.rid = l.rid WHERE l.rid = $1 AND r.deleted_at IS NULL`, rid).Scan(&l.BasedOn, &l.State, &l.UpdatedAt)
	if err != nil {
		return nil, translate(err)
	}
	return &l, nil
}

// PutLiveState keeps the live document of a resource in place of the one before.
func (s *Store) PutLiveState(ctx context.Context, rid uuid.UUID, basedOn *int, state []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO live_state (rid, based_on, state) VALUES ($1, $2, $3)
		ON CONFLICT (rid) DO UPDATE SET based_on = EXCLUDED.based_on, state = EXCLUDED.state, updated_at = now()`, rid, basedOn, state)
	return translate(err)
}
