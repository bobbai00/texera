package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const resourceColumns = `rid, kind, name, description, parent_rid, visibility, labels, spec, status, head_vno,
	owner_pid, created_by_pid, on_behalf_of_pid, origin_conversation_rid, origin_seq, created_at, updated_at, deleted_at`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanResource(row rowScanner) (*Resource, error) {
	var r Resource
	var originRID *uuid.UUID
	var originSeq *int64
	if err := row.Scan(&r.RID, &r.Kind, &r.Name, &r.Description, &r.ParentRID, &r.Visibility, &r.Labels, &r.Spec, &r.Status,
		&r.HeadVno, &r.OwnerPID, &r.CreatedByPID, &r.OnBehalfOfPID, &originRID, &originSeq, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt); err != nil {
		return nil, notFound(err)
	}
	if originRID != nil && originSeq != nil {
		r.Origin = &Origin{Conversation: *originRID, Seq: *originSeq}
	}
	if r.Labels == nil {
		r.Labels = map[string]string{}
	}
	return &r, nil
}

// NewResource is the input for CreateResource.
type NewResource struct {
	Kind          string
	Name          string
	Description   *string
	ParentRID     *uuid.UUID
	Visibility    string
	Labels        map[string]string
	Spec          json.RawMessage
	OwnerPID      uuid.UUID
	CreatedByPID  uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	// First version content; when nil no version is written and head_vno stays 0.
	Content     json.RawMessage
	ContentKind string
	ContentRef  *string
	Message     *string
}

// CreateResource inserts the envelope, its first version (when content is given) and the
// owner grant, in one transaction.
func (s *Store) CreateResource(ctx context.Context, in NewResource) (*Resource, *Version, error) {
	if in.Visibility == "" {
		in.Visibility = "private"
	}
	if in.Labels == nil {
		in.Labels = map[string]string{}
	}
	if len(in.Spec) == 0 {
		in.Spec = json.RawMessage(`{}`)
	}
	var res *Resource
	var ver *Version
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var originRID *uuid.UUID
		var originSeq *int64
		if in.Origin != nil {
			originRID, originSeq = &in.Origin.Conversation, &in.Origin.Seq
		}
		r, err := scanResource(tx.QueryRow(ctx, `INSERT INTO resource
			(kind, name, description, parent_rid, visibility, labels, spec, owner_pid, created_by_pid, on_behalf_of_pid, origin_conversation_rid, origin_seq)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING `+resourceColumns,
			in.Kind, in.Name, in.Description, in.ParentRID, in.Visibility, in.Labels, in.Spec, in.OwnerPID, in.CreatedByPID, in.OnBehalfOfPID, originRID, originSeq))
		if err != nil {
			return err
		}
		res = r
		if _, err := tx.Exec(ctx, `INSERT INTO access_grant (rid, pid, relation) VALUES ($1, $2, 'owner')`, r.RID, in.OwnerPID); err != nil {
			return err
		}
		if err := enqueueTuple(ctx, tx, "write", r, in.OwnerPID, "owner"); err != nil {
			return err
		}
		if r.ParentRID != nil {
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('write', $1, 'parent', $2)`,
				"resource:"+r.RID.String(), "resource:"+r.ParentRID.String()); err != nil {
				return err
			}
		}
		if in.Visibility == "public" {
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('write', $1, 'viewer', 'user:*')`,
				"resource:"+r.RID.String()); err != nil {
				return err
			}
		}
		if in.Content != nil || in.ContentRef != nil {
			kind := in.ContentKind
			if kind == "" {
				kind = "json"
			}
			v, err := insertVersion(ctx, tx, r.RID, kind, in.ContentRef, in.Content, in.Message, in.CreatedByPID, in.OnBehalfOfPID, in.Origin)
			if err != nil {
				return err
			}
			ver = v
			res.HeadVno = v.Vno
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return res, ver, nil
}

func enqueueTuple(ctx context.Context, tx pgx.Tx, op string, r *Resource, pid uuid.UUID, relation string) error {
	subjectType, err := subjectTypeOf(ctx, tx, pid)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ($1, $2, $3, $4)`,
		op, "resource:"+r.RID.String(), relation, subjectType+":"+pid.String())
	return err
}

func subjectTypeOf(ctx context.Context, tx pgx.Tx, pid uuid.UUID) (string, error) {
	var kind string
	if err := tx.QueryRow(ctx, `SELECT kind FROM principal WHERE pid = $1`, pid).Scan(&kind); err != nil {
		return "", notFound(err)
	}
	if kind == "group" {
		return "group", nil
	}
	return kind, nil
}

// GetResource returns a live resource.
func (s *Store) GetResource(ctx context.Context, rid uuid.UUID) (*Resource, error) {
	return scanResource(s.pool.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource WHERE rid = $1 AND deleted_at IS NULL`, rid))
}

// SearchResources lists resources matching the filter, newest first, with offset paging.
func (s *Store) SearchResources(ctx context.Context, f ResourceFilter) ([]Resource, error) {
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	args := []any{}
	where := []string{"r.deleted_at IS NULL"}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if f.Kind != "" {
		add("r.kind = $%d", f.Kind)
	}
	if f.ParentRID != nil {
		add("r.parent_rid = $%d", *f.ParentRID)
	}
	if f.Origin != nil {
		add("r.origin_conversation_rid = $%d", *f.Origin)
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		add("(r.search @@ plainto_tsquery('simple', $%d) OR r.name ILIKE '%%' || $%[1]d || '%%')", q)
	}
	if f.ReadableBy != nil {
		add(`(r.visibility = 'public' OR r.owner_pid = $%d OR EXISTS (SELECT 1 FROM access_grant g WHERE g.rid = r.rid AND g.pid = $%[1]d)
			OR EXISTS (SELECT 1 FROM access_grant g JOIN resource p ON p.rid = g.rid WHERE g.pid = $%[1]d AND p.kind = 'project'
				AND r.parent_rid = p.rid))`, *f.ReadableBy)
	}
	args = append(args, limit, f.Offset)
	sql := `SELECT ` + resourceColumns + ` FROM resource r WHERE ` + strings.Join(where, " AND ") +
		fmt.Sprintf(` ORDER BY r.updated_at DESC, r.rid LIMIT $%d OFFSET $%d`, len(args)-1, len(args))
	rows, err := s.pool.Query(ctx, sql, args...)
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
	return out, rows.Err()
}

// MetadataPatch holds optional metadata changes.
type MetadataPatch struct {
	Name        *string
	Description *string
	ParentRID   *uuid.UUID
	Visibility  *string
	Labels      map[string]string
}

// UpdateMetadata applies a metadata patch.
func (s *Store) UpdateMetadata(ctx context.Context, rid uuid.UUID, p MetadataPatch) (*Resource, error) {
	var out *Resource
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		before, err := scanResource(tx.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource WHERE rid = $1 AND deleted_at IS NULL FOR UPDATE`, rid))
		if err != nil {
			return err
		}
		r, err := scanResource(tx.QueryRow(ctx, `UPDATE resource SET
			name = COALESCE($2, name), description = COALESCE($3, description), parent_rid = COALESCE($4, parent_rid),
			visibility = COALESCE($5, visibility), labels = COALESCE($6, labels), updated_at = now()
			WHERE rid = $1 RETURNING `+resourceColumns,
			rid, p.Name, p.Description, p.ParentRID, p.Visibility, nullableLabels(p.Labels)))
		if err != nil {
			return err
		}
		out = r
		if p.Visibility != nil && *p.Visibility != before.Visibility {
			op := "delete"
			if *p.Visibility == "public" {
				op = "write"
			}
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ($1, $2, 'viewer', 'user:*')`, op, "resource:"+rid.String()); err != nil {
				return err
			}
		}
		if p.ParentRID != nil && (before.ParentRID == nil || *before.ParentRID != *p.ParentRID) {
			if before.ParentRID != nil {
				if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('delete', $1, 'parent', $2)`,
					"resource:"+rid.String(), "resource:"+before.ParentRID.String()); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('write', $1, 'parent', $2)`,
				"resource:"+rid.String(), "resource:"+p.ParentRID.String()); err != nil {
				return err
			}
		}
		return nil
	})
	return out, err
}

func nullableLabels(m map[string]string) any {
	if m == nil {
		return nil
	}
	return m
}

// UpdateSpec replaces the kind-specific spec.
func (s *Store) UpdateSpec(ctx context.Context, rid uuid.UUID, spec json.RawMessage) (*Resource, error) {
	return scanResource(s.pool.QueryRow(ctx, `UPDATE resource SET spec = $2, updated_at = now() WHERE rid = $1 AND deleted_at IS NULL RETURNING `+resourceColumns, rid, spec))
}

// UpdateStatus replaces the kind-specific status.
func (s *Store) UpdateStatus(ctx context.Context, rid uuid.UUID, status json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `UPDATE resource SET status = $2, updated_at = now() WHERE rid = $1`, rid, status)
	return err
}

// SoftDeleteResource marks a resource deleted and drops its grants from the PDP.
func (s *Store) SoftDeleteResource(ctx context.Context, rid uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE resource SET deleted_at = now(), updated_at = now() WHERE rid = $1 AND deleted_at IS NULL`, rid)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		rows, err := tx.Query(ctx, `SELECT g.pid, g.relation, p.kind FROM access_grant g JOIN principal p ON p.pid = g.pid WHERE g.rid = $1`, rid)
		if err != nil {
			return err
		}
		type g struct {
			pid      uuid.UUID
			relation string
			kind     string
		}
		var grants []g
		for rows.Next() {
			var x g
			if err := rows.Scan(&x.pid, &x.relation, &x.kind); err != nil {
				rows.Close()
				return err
			}
			grants = append(grants, x)
		}
		rows.Close()
		for _, x := range grants {
			if _, err := tx.Exec(ctx, `INSERT INTO access_outbox (op, object, relation, subject) VALUES ('delete', $1, $2, $3)`,
				"resource:"+rid.String(), x.relation, x.kind+":"+x.pid.String()); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `DELETE FROM access_grant WHERE rid = $1`, rid)
		return err
	})
}

// ---- versions ----

const versionColumns = `rid, vno, content_kind, content_ref, content, message, created_by_pid, on_behalf_of_pid, origin_conversation_rid, origin_seq, created_at`

func scanVersion(row rowScanner) (*Version, error) {
	var v Version
	var originRID *uuid.UUID
	var originSeq *int64
	if err := row.Scan(&v.RID, &v.Vno, &v.ContentKind, &v.ContentRef, &v.Content, &v.Message, &v.CreatedByPID, &v.OnBehalfOfPID, &originRID, &originSeq, &v.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	if originRID != nil && originSeq != nil {
		v.Origin = &Origin{Conversation: *originRID, Seq: *originSeq}
	}
	return &v, nil
}

func insertVersion(ctx context.Context, tx pgx.Tx, rid uuid.UUID, kind string, ref *string, content json.RawMessage, message *string,
	by uuid.UUID, onBehalfOf *uuid.UUID, origin *Origin) (*Version, error) {
	var vno int32
	if err := tx.QueryRow(ctx, `UPDATE resource SET head_vno = head_vno + 1, updated_at = now() WHERE rid = $1 AND deleted_at IS NULL RETURNING head_vno`, rid).Scan(&vno); err != nil {
		return nil, notFound(err)
	}
	var originRID *uuid.UUID
	var originSeq *int64
	if origin != nil {
		originRID, originSeq = &origin.Conversation, &origin.Seq
	}
	return scanVersion(tx.QueryRow(ctx, `INSERT INTO resource_version
		(rid, vno, content_kind, content_ref, content, message, created_by_pid, on_behalf_of_pid, origin_conversation_rid, origin_seq)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING `+versionColumns,
		rid, vno, kind, ref, content, message, by, onBehalfOf, originRID, originSeq))
}

// NewVersion is the input for CreateVersion.
type NewVersion struct {
	RID           uuid.UUID
	ContentKind   string
	ContentRef    *string
	Content       json.RawMessage
	Message       *string
	CreatedByPID  uuid.UUID
	OnBehalfOfPID *uuid.UUID
	Origin        *Origin
	// ExpectedHead, when set, must equal the current head or ErrConflict is returned.
	ExpectedHead *int32
}

// CreateVersion appends a version to a resource.
func (s *Store) CreateVersion(ctx context.Context, in NewVersion) (*Version, error) {
	if in.ContentKind == "" {
		in.ContentKind = "json"
	}
	var out *Version
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if in.ExpectedHead != nil {
			var head int32
			if err := tx.QueryRow(ctx, `SELECT head_vno FROM resource WHERE rid = $1 AND deleted_at IS NULL FOR UPDATE`, in.RID).Scan(&head); err != nil {
				return notFound(err)
			}
			if head != *in.ExpectedHead {
				return ErrConflict
			}
		}
		v, err := insertVersion(ctx, tx, in.RID, in.ContentKind, in.ContentRef, in.Content, in.Message, in.CreatedByPID, in.OnBehalfOfPID, in.Origin)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

// GetVersion returns one version; vno 0 means the head.
func (s *Store) GetVersion(ctx context.Context, rid uuid.UUID, vno int32) (*Version, error) {
	if vno <= 0 {
		return scanVersion(s.pool.QueryRow(ctx, `SELECT `+versionColumns+` FROM resource_version WHERE rid = $1 ORDER BY vno DESC LIMIT 1`, rid))
	}
	return scanVersion(s.pool.QueryRow(ctx, `SELECT `+versionColumns+` FROM resource_version WHERE rid = $1 AND vno = $2`, rid, vno))
}

// ListVersions returns versions newest first.
func (s *Store) ListVersions(ctx context.Context, rid uuid.UUID, limit, offset int) ([]Version, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT `+versionColumns+` FROM resource_version WHERE rid = $1 ORDER BY vno DESC LIMIT $2 OFFSET $3`, rid, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// Touch bumps updated_at (e.g. after a message is appended).
func (s *Store) Touch(ctx context.Context, rid uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE resource SET updated_at = $2 WHERE rid = $1`, rid, time.Now())
	return err
}

// IsNotFound reports whether err is ErrNotFound.
func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

// IsConflict reports whether err is ErrConflict.
func IsConflict(err error) bool { return errors.Is(err, ErrConflict) }
