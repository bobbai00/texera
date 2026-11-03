package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const messageColumns = `conversation_rid, seq, role, author_pid, on_behalf_of_pid, parts, created_at`

func scanMessage(row rowScanner) (*Message, error) {
	var m Message
	if err := row.Scan(&m.ConversationRID, &m.Seq, &m.Role, &m.AuthorPID, &m.OnBehalfOfPID, &m.Parts, &m.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	return &m, nil
}

// AppendMessage appends a message with the next seq, serializing per conversation.
func (s *Store) AppendMessage(ctx context.Context, conversation uuid.UUID, role string, author uuid.UUID, onBehalfOf *uuid.UUID, parts json.RawMessage) (*Message, error) {
	if len(parts) == 0 {
		parts = json.RawMessage(`[]`)
	}
	var out *Message
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// Lock the conversation row so seq allocation is serialized.
		var kind string
		if err := tx.QueryRow(ctx, `SELECT kind FROM resource WHERE rid = $1 AND deleted_at IS NULL FOR UPDATE`, conversation).Scan(&kind); err != nil {
			return notFound(err)
		}
		if kind != "conversation" {
			return ErrNotFound
		}
		m, err := scanMessage(tx.QueryRow(ctx, `INSERT INTO message (conversation_rid, seq, role, author_pid, on_behalf_of_pid, parts)
			VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM message WHERE conversation_rid = $1), $2, $3, $4, $5)
			RETURNING `+messageColumns, conversation, role, author, onBehalfOf, parts))
		if err != nil {
			return err
		}
		out = m
		_, err = tx.Exec(ctx, `UPDATE resource SET updated_at = now(),
			status = COALESCE(status, '{}'::jsonb) || jsonb_build_object('messages', $2::bigint, 'lastMessageAt', to_jsonb(now()))
			WHERE rid = $1`, conversation, m.Seq)
		return err
	})
	return out, err
}

// ListMessages returns messages with seq > after, in order.
func (s *Store) ListMessages(ctx context.Context, conversation uuid.UUID, after int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `SELECT `+messageColumns+` FROM message WHERE conversation_rid = $1 AND seq > $2 ORDER BY seq LIMIT $3`, conversation, after, limit)
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
