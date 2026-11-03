package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const agentColumns = `pid, template_rid, template_vno, spawned_by_pid, conversation_rid, eid, opid, lifetime, status, created_at`

func scanAgent(row rowScanner) (*Agent, error) {
	var a Agent
	if err := row.Scan(&a.PID, &a.TemplateRID, &a.TemplateVno, &a.SpawnedByPID, &a.ConversationRID, &a.EID, &a.Opid, &a.Lifetime, &a.Status, &a.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	return &a, nil
}

// NewAgent is the input for SpawnAgent.
type NewAgent struct {
	DisplayName     string
	SponsorPID      uuid.UUID
	TemplateRID     uuid.UUID
	TemplateVno     int32
	SpawnedByPID    *uuid.UUID
	ConversationRID *uuid.UUID
	EID             *uuid.UUID
	Opid            *string
	Lifetime        string
}

// SpawnAgent creates the agent principal and its agent row, and grants it editor access to
// its conversation so it may post.
func (s *Store) SpawnAgent(ctx context.Context, in NewAgent) (*Agent, error) {
	if in.Lifetime == "" {
		in.Lifetime = "conversation"
	}
	var out *Agent
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		pid := uuid.New()
		if _, err := tx.Exec(ctx, `INSERT INTO principal (pid, kind, display_name, sponsor_pid) VALUES ($1, 'agent', $2, $3)`, pid, in.DisplayName, in.SponsorPID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('write', $1, 'sponsor', $2)`,
			"agent:"+pid.String(), "user:"+in.SponsorPID.String()); err != nil {
			return err
		}
		a, err := scanAgent(tx.QueryRow(ctx, `INSERT INTO agent (pid, template_rid, template_vno, spawned_by_pid, conversation_rid, eid, opid, lifetime)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING `+agentColumns,
			pid, in.TemplateRID, in.TemplateVno, in.SpawnedByPID, in.ConversationRID, in.EID, in.Opid, in.Lifetime))
		if err != nil {
			return err
		}
		out = a
		if in.ConversationRID != nil {
			if _, err := tx.Exec(ctx, `INSERT INTO access_grant (rid, pid, relation) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`, *in.ConversationRID, pid); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('write', $1, 'editor', $2)`,
				"resource:"+in.ConversationRID.String(), "agent:"+pid.String()); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE resource SET status = COALESCE(status, '{}'::jsonb) || jsonb_build_object('agent', $2::text) WHERE rid = $1`,
				*in.ConversationRID, pid.String()); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

// GetAgent returns an agent row.
func (s *Store) GetAgent(ctx context.Context, pid uuid.UUID) (*Agent, error) {
	return scanAgent(s.pool.QueryRow(ctx, `SELECT `+agentColumns+` FROM agent WHERE pid = $1`, pid))
}

// ListAgents lists agents by conversation or execution.
func (s *Store) ListAgents(ctx context.Context, conversation, eid *uuid.UUID) ([]Agent, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+agentColumns+` FROM agent
		WHERE ($1::uuid IS NULL OR conversation_rid = $1) AND ($2::uuid IS NULL OR eid = $2) ORDER BY created_at`, conversation, eid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Agent
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

// RetireAgent marks an agent retired.
func (s *Store) RetireAgent(ctx context.Context, pid uuid.UUID) (*Agent, error) {
	return scanAgent(s.pool.QueryRow(ctx, `UPDATE agent SET status = 'retired' WHERE pid = $1 RETURNING `+agentColumns, pid))
}
