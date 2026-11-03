package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const executionColumns = `eid, name, workflow_rid, workflow_vno, env_rid, env_vno, cu_rid, actor_pid, on_behalf_of_pid,
	origin_conversation_rid, origin_seq, parameters, status, error, operators, created_at, started_at, finished_at`

func scanExecution(row rowScanner) (*Execution, error) {
	var e Execution
	var originRID *uuid.UUID
	var originSeq *int64
	if err := row.Scan(&e.EID, &e.Name, &e.WorkflowRID, &e.WorkflowVno, &e.EnvRID, &e.EnvVno, &e.CuRID, &e.ActorPID, &e.OnBehalfOfPID,
		&originRID, &originSeq, &e.Parameters, &e.Status, &e.Error, &e.Operators, &e.CreatedAt, &e.StartedAt, &e.FinishedAt); err != nil {
		return nil, notFound(err)
	}
	if originRID != nil && originSeq != nil {
		e.Origin = &Origin{Conversation: *originRID, Seq: *originSeq}
	}
	return &e, nil
}

// NewExecution is the input for CreateExecution.
type NewExecution struct {
	Name          *string
	WorkflowRID   uuid.UUID
	WorkflowVno   int32
	EnvRID        *uuid.UUID
	EnvVno        *int32
	CuRID         uuid.UUID
	ActorPID      uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	Parameters    json.RawMessage
	// Inputs are the dataset versions the run reads; recorded as execution_input and version edges.
	Inputs []VersionRef
}

// CreateExecution inserts a pending execution with its pinned inputs.
func (s *Store) CreateExecution(ctx context.Context, in NewExecution) (*Execution, error) {
	var out *Execution
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var originRID *uuid.UUID
		var originSeq *int64
		if in.Origin != nil {
			originRID, originSeq = &in.Origin.Conversation, &in.Origin.Seq
		}
		e, err := scanExecution(tx.QueryRow(ctx, `INSERT INTO execution
			(name, workflow_rid, workflow_vno, env_rid, env_vno, cu_rid, actor_pid, on_behalf_of_pid, origin_conversation_rid, origin_seq, parameters)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING `+executionColumns,
			in.Name, in.WorkflowRID, in.WorkflowVno, in.EnvRID, in.EnvVno, in.CuRID, in.ActorPID, in.OnBehalfOfPID, originRID, originSeq, in.Parameters))
		if err != nil {
			return err
		}
		out = e
		for _, ref := range in.Inputs {
			if _, err := tx.Exec(ctx, `INSERT INTO execution_input (eid, rid, vno) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, e.EID, ref.RID, ref.Vno); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO version_edge (from_rid, from_vno, to_rid, to_vno, kind, eid) VALUES ($1, $2, $3, $4, 'read', $5) ON CONFLICT DO NOTHING`,
				ref.RID, ref.Vno, in.WorkflowRID, in.WorkflowVno, e.EID); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `UPDATE resource SET status = COALESCE(status, '{}'::jsonb) || jsonb_build_object('lastExecution', $2::text), updated_at = now() WHERE rid = $1`,
			in.WorkflowRID, e.EID.String())
		return err
	})
	return out, err
}

// GetExecution returns an execution.
func (s *Store) GetExecution(ctx context.Context, eid uuid.UUID) (*Execution, error) {
	return scanExecution(s.pool.QueryRow(ctx, `SELECT `+executionColumns+` FROM execution WHERE eid = $1`, eid))
}

// ListExecutions lists executions by workflow and/or conversation, newest first.
func (s *Store) ListExecutions(ctx context.Context, workflow, conversation *uuid.UUID, limit, offset int) ([]Execution, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT `+executionColumns+` FROM execution
		WHERE ($1::uuid IS NULL OR workflow_rid = $1) AND ($2::uuid IS NULL OR origin_conversation_rid = $2)
		ORDER BY created_at DESC LIMIT $3 OFFSET $4`, workflow, conversation, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Execution
	for rows.Next() {
		e, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

// SetExecutionStatus transitions an execution; started/finished timestamps follow the status.
func (s *Store) SetExecutionStatus(ctx context.Context, eid uuid.UUID, status string, errBody json.RawMessage) (*Execution, error) {
	now := time.Now()
	var started, finished *time.Time
	switch status {
	case "running":
		started = &now
	case "completed", "failed", "cancelled":
		finished = &now
	}
	return scanExecution(s.pool.QueryRow(ctx, `UPDATE execution SET status = $2, error = COALESCE($3, error),
		started_at = COALESCE(started_at, $4), finished_at = COALESCE($5, finished_at) WHERE eid = $1 RETURNING `+executionColumns,
		eid, status, errBody, started, finished))
}

// MergeOperatorState merges one operator's run state into the execution's operators map.
func (s *Store) MergeOperatorState(ctx context.Context, eid uuid.UUID, opid string, state json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `UPDATE execution SET operators = operators || jsonb_build_object($2::text, $3::jsonb) WHERE eid = $1`, eid, opid, state)
	return err
}

// UpsertPortResult records or updates a port result.
func (s *Store) UpsertPortResult(ctx context.Context, p PortResult) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO port_result (eid, opid, port, table_id, snapshot_id, tuple_count, bytes, hash)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (eid, opid, port) DO UPDATE SET table_id = COALESCE(EXCLUDED.table_id, port_result.table_id),
			snapshot_id = COALESCE(EXCLUDED.snapshot_id, port_result.snapshot_id), tuple_count = COALESCE(EXCLUDED.tuple_count, port_result.tuple_count),
			bytes = COALESCE(EXCLUDED.bytes, port_result.bytes), hash = COALESCE(EXCLUDED.hash, port_result.hash)`,
		p.EID, p.Opid, p.Port, p.TableID, p.SnapshotID, p.TupleCount, p.Bytes, p.Hash)
	return err
}

// ListPortResults returns the port results of an execution.
func (s *Store) ListPortResults(ctx context.Context, eid uuid.UUID) ([]PortResult, error) {
	rows, err := s.pool.Query(ctx, `SELECT eid, opid, port, table_id, snapshot_id, tuple_count, bytes, hash FROM port_result WHERE eid = $1 ORDER BY opid, port`, eid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PortResult
	for rows.Next() {
		var p PortResult
		if err := rows.Scan(&p.EID, &p.Opid, &p.Port, &p.TableID, &p.SnapshotID, &p.TupleCount, &p.Bytes, &p.Hash); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AddPortEdge records that a port consumed another port's result.
func (s *Store) AddPortEdge(ctx context.Context, e PortEdge) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO port_edge (eid, opid, port, from_eid, from_opid, from_port) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
		e.EID, e.Opid, e.Port, e.FromEID, e.FromOpid, e.FromPort)
	return err
}

// AddPortInput records that a source port read a dataset version file.
func (s *Store) AddPortInput(ctx context.Context, in PortInput) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO port_input (eid, opid, port, rid, vno, path) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
		in.EID, in.Opid, in.Port, in.RID, in.Vno, in.Path)
	return err
}

// AddVersionEdge records a resource-level lineage edge.
func (s *Store) AddVersionEdge(ctx context.Context, e VersionEdge) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO version_edge (from_rid, from_vno, to_rid, to_vno, kind, eid) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
		e.From.RID, e.From.Vno, e.To.RID, e.To.Vno, e.Kind, e.EID)
	return err
}

// ListExecutionInputs returns the pinned inputs of an execution.
func (s *Store) ListExecutionInputs(ctx context.Context, eid uuid.UUID) ([]VersionRef, error) {
	rows, err := s.pool.Query(ctx, `SELECT rid, vno FROM execution_input WHERE eid = $1 ORDER BY rid, vno`, eid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VersionRef
	for rows.Next() {
		var r VersionRef
		if err := rows.Scan(&r.RID, &r.Vno); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Lineage returns the version edges into and out of a resource version; vno 0 means all versions.
func (s *Store) Lineage(ctx context.Context, rid uuid.UUID, vno int32) (upstream, downstream []VersionEdge, err error) {
	scan := func(rows pgx.Rows) ([]VersionEdge, error) {
		defer rows.Close()
		var out []VersionEdge
		for rows.Next() {
			var e VersionEdge
			if err := rows.Scan(&e.From.RID, &e.From.Vno, &e.To.RID, &e.To.Vno, &e.Kind, &e.EID); err != nil {
				return nil, err
			}
			out = append(out, e)
		}
		return out, rows.Err()
	}
	rows, err := s.pool.Query(ctx, `SELECT from_rid, from_vno, to_rid, to_vno, kind, eid FROM version_edge WHERE to_rid = $1 AND ($2 = 0 OR to_vno = $2) ORDER BY from_rid, from_vno`, rid, vno)
	if err != nil {
		return nil, nil, err
	}
	if upstream, err = scan(rows); err != nil {
		return nil, nil, err
	}
	rows, err = s.pool.Query(ctx, `SELECT from_rid, from_vno, to_rid, to_vno, kind, eid FROM version_edge WHERE from_rid = $1 AND ($2 = 0 OR from_vno = $2) ORDER BY to_rid, to_vno`, rid, vno)
	if err != nil {
		return nil, nil, err
	}
	if downstream, err = scan(rows); err != nil {
		return nil, nil, err
	}
	return upstream, downstream, nil
}

// StoreLineageEvent keeps a raw OpenLineage event.
func (s *Store) StoreLineageEvent(ctx context.Context, eid *uuid.UUID, body json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO lineage_event (eid, body) VALUES ($1, $2)`, eid, body)
	return err
}
