package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const messageColumns = `m.conversation_rid, m.seq, m.turn, m.role, m.author_pid, m.template_uri, m.model_endpoint_uri, m.mcp_server_uris, m.parts, m.created_at, m.updated_at`

// NewMessage is what AppendMessage needs.
type NewMessage struct {
	ConversationRID uuid.UUID
	Turn            *string
	Role            string
	AuthorPID       uuid.UUID
	Template        *string
	ModelEndpoint   *string
	McpServers      []string
	Parts           json.RawMessage
}

// AppendMessage assigns the next seq under the conversation's lock and keeps the
// conversation's message count and last message time in its status.
func (s *Store) AppendMessage(ctx context.Context, in NewMessage) (*Message, error) {
	if len(in.Parts) == 0 {
		in.Parts = json.RawMessage(`[]`)
	}
	var m *Message
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if _, err := lockResource(ctx, tx, in.ConversationRID); err != nil {
			return err
		}
		var turn *uuid.UUID
		if in.Turn != nil {
			t, err := uuid.Parse(*in.Turn)
			if err != nil {
				return err
			}
			turn = &t
		}
		row := tx.QueryRow(ctx, `INSERT INTO message AS m (conversation_rid, seq, turn, role, author_pid, template_uri, model_endpoint_uri, mcp_server_uris, parts)
			SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, $6, $7, $8 FROM message WHERE conversation_rid = $1
			RETURNING `+messageColumns,
			in.ConversationRID, turn, in.Role, in.AuthorPID, in.Template, in.ModelEndpoint, in.McpServers, in.Parts)
		var err error
		m, err = scanMessage(row)
		if err != nil {
			return translate(err)
		}
		_, err = tx.Exec(ctx, `UPDATE resource SET status = coalesce(status, '{}'::jsonb) || jsonb_build_object('messages', $2::bigint, 'lastMessageAt', now()), etag = $3, updated_at = now() WHERE rid = $1`,
			in.ConversationRID, m.Seq, newEtag())
		return err
	})
	if err != nil {
		return nil, err
	}
	s.changed(Change{RID: in.ConversationRID, Message: m})
	return m, nil
}

// ReplaceMessage replaces the parts (and template) of a message.
func (s *Store) ReplaceMessage(ctx context.Context, conversation uuid.UUID, seq int64, parts json.RawMessage, template *string) (*Message, error) {
	if len(parts) == 0 {
		parts = json.RawMessage(`[]`)
	}
	row := s.pool.QueryRow(ctx, `UPDATE message m SET parts = $3, template_uri = coalesce($4, m.template_uri), updated_at = now()
		WHERE m.conversation_rid = $1 AND m.seq = $2 RETURNING `+messageColumns, conversation, seq, parts, template)
	m, err := scanMessage(row)
	if err == nil {
		s.changed(Change{RID: conversation, Message: m})
	}
	return m, translate(err)
}

// ListMessages returns messages after a seq, in order.
func (s *Store) ListMessages(ctx context.Context, conversation uuid.UUID, after int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM message m WHERE m.conversation_rid = $1 AND m.seq > $2 ORDER BY m.seq LIMIT $3`, conversation, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

// Attached returns what people attached to their messages in a conversation, by name, first
// attached first.
func (s *Store) Attached(ctx context.Context, conversation uuid.UUID) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT p ->> 'resource' FROM message m, jsonb_array_elements(m.parts) p
		WHERE m.conversation_rid = $1 AND m.role = 'user' AND p ->> 'type' = 'resource' AND p ->> 'resource' IS NOT NULL
		ORDER BY m.seq`, conversation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// StartTurn takes the conversation's turn lock for a person; ErrConflict when a turn is active.
func (s *Store) StartTurn(ctx context.Context, conversation uuid.UUID, turn string, by *uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `UPDATE resource SET status = coalesce(status, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('activeTurn', $2::text, 'activeTurnBy', $4::text)), etag = $3, updated_at = now()
		WHERE rid = $1 AND deleted_at IS NULL AND kind = 'conversation' AND (status ->> 'activeTurn') IS NULL`, conversation, turn, newEtag(), by)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, err := s.GetResource(ctx, conversation); err != nil {
			return err
		}
		return ErrConflict
	}
	s.changed(Change{RID: conversation})
	return nil
}

// EndTurn releases the turn lock when the given turn holds it.
func (s *Store) EndTurn(ctx context.Context, conversation uuid.UUID, turn string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE resource SET status = status - 'activeTurn' - 'activeTurnBy', etag = $3, updated_at = now()
		WHERE rid = $1 AND (status ->> 'activeTurn') = $2`, conversation, turn, newEtag())
	if err == nil && tag.RowsAffected() > 0 {
		s.changed(Change{RID: conversation})
	}
	return err
}

func scanMessage(row scanner) (*Message, error) {
	var m Message
	var turn *uuid.UUID
	if err := row.Scan(&m.ConversationRID, &m.Seq, &turn, &m.Role, &m.AuthorPID, &m.Template, &m.ModelEndpoint, &m.McpServers, &m.Parts, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return nil, err
	}
	if turn != nil {
		t := turn.String()
		m.Turn = &t
	}
	return &m, nil
}
