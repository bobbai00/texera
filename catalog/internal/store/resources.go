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

const resourceColumns = `r.rid, r.kind, r.name, r.description, r.parent_rid, r.project_rid, r.owner_pid, r.visibility,
	r.labels, r.spec, r.status, r.head_vno, r.etag, r.created_by_pid, r.origin, r.created_at, r.updated_at`

// NewResource is what CreateResource needs.
type NewResource struct {
	// RID fixes the id (the settings singleton); nil draws one.
	RID          *uuid.UUID
	Kind         string
	Name         string
	Description  *string
	ParentRID    *uuid.UUID
	ProjectRID   *uuid.UUID
	OwnerPID     uuid.UUID
	CreatedByPID uuid.UUID
	Visibility   string
	Labels       map[string]string
	Spec         json.RawMessage
	Status       json.RawMessage
	Origin       *Origin
	// Versioned kinds get version 1 with Content (the spec for spec kinds) and Message.
	Versioned   bool
	ContentKind string
	Content     json.RawMessage
	Message     *string
	// References are the edges extracted from the first version's content.
	References []Edge
}

// CreateResource inserts the resource, its first version when versioned, the owner's grant,
// the tuples for the relay, and the reference edges, in one transaction.
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
	rid := uuid.New()
	if in.RID != nil {
		rid = *in.RID
	}
	if in.Kind == "project" {
		in.ProjectRID = &rid
	}
	var r *Resource
	var v *Version
	err := s.tx(ctx, func(tx pgx.Tx) error {
		labels, _ := json.Marshal(in.Labels)
		origin, _ := marshalOrigin(in.Origin)
		head := 0
		if in.Versioned {
			head = 1
		}
		row := tx.QueryRow(ctx, `INSERT INTO resource AS r (rid, kind, name, description, parent_rid, project_rid, owner_pid, visibility, labels, spec, status, head_vno, etag, created_by_pid, origin)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING `+resourceColumns,
			rid, in.Kind, in.Name, in.Description, in.ParentRID, in.ProjectRID, in.OwnerPID, in.Visibility, labels, in.Spec, nullableJSON(in.Status), head, newEtag(), in.CreatedByPID, origin)
		var err error
		r, err = scanResource(row)
		if err != nil {
			return translate(err)
		}
		if in.Versioned {
			v, err = insertVersion(ctx, tx, NewVersion{RID: rid, Vno: 1, ContentKind: in.ContentKind, Content: in.Content, Message: in.Message, CreatedByPID: in.CreatedByPID, Origin: in.Origin})
			if err != nil {
				return err
			}
		}
		if err := writeGrant(ctx, tx, rid, in.OwnerPID, "owner"); err != nil {
			return err
		}
		if in.ParentRID != nil {
			if err := enqueue(ctx, tx, "write", object(rid), "parent", object(*in.ParentRID)); err != nil {
				return err
			}
		}
		if in.Visibility == "public" {
			if err := enqueue(ctx, tx, "write", object(rid), "viewer", "user:*"); err != nil {
				return err
			}
		}
		return replaceReferences(ctx, tx, in.References)
	})
	if err != nil {
		return nil, nil, err
	}
	return r, v, nil
}

// GetResource returns a live resource.
func (s *Store) GetResource(ctx context.Context, rid uuid.UUID) (*Resource, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource r WHERE r.rid = $1 AND r.deleted_at IS NULL`, rid)
	r, err := scanResource(row)
	return r, translate(err)
}

// ResourceFilter selects resources for a list.
type ResourceFilter struct {
	Kind       string
	ParentRID  *uuid.UUID
	ProjectRID *uuid.UUID
	OwnerPID   *uuid.UUID
	// Name matches exactly, case-insensitively.
	Name string
	// Query is a full-text or substring search over name and description.
	Query string
	// OriginConversation selects what a conversation produced.
	OriginConversation *uuid.UUID
	// Labels must all be present with these values.
	Labels map[string]string
	// Fields restricts spec or status fields, by JSON pointer, to a value.
	Fields map[string]string
	// Absent lists spec or status fields, by JSON pointer, that must not be set.
	Absent []string
	// UpdatedBefore keeps resources last changed before the instant.
	UpdatedBefore *time.Time
	// ReadableBy restricts to what the principal may read: public, owned, or granted directly
	// or through the parent or the project. Nil means no restriction (an administrator or a
	// service).
	ReadableBy *uuid.UUID
	Limit      int
	Offset     int
}

// ListResources returns the matching resources, newest update first.
func (s *Store) ListResources(ctx context.Context, f ResourceFilter) ([]Resource, error) {
	var where []string
	var args []any
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	where = append(where, "r.deleted_at IS NULL")
	if f.Kind != "" {
		add("r.kind = $%d", f.Kind)
	}
	if f.ParentRID != nil {
		add("r.parent_rid = $%d", *f.ParentRID)
	}
	if f.ProjectRID != nil {
		add("r.project_rid = $%d", *f.ProjectRID)
	}
	if f.OwnerPID != nil {
		add("r.owner_pid = $%d", *f.OwnerPID)
	}
	if f.Name != "" {
		add("lower(r.name) = lower($%d)", f.Name)
	}
	if q := strings.TrimSpace(f.Query); q != "" {
		add("(r.search @@ plainto_tsquery('simple', $%d) OR r.name ILIKE '%%' || $%[1]d || '%%')", q)
	}
	if f.OriginConversation != nil {
		add("r.origin ->> 'conversation' = $%d", f.OriginConversation.String())
	}
	if len(f.Labels) > 0 {
		labels, _ := json.Marshal(f.Labels)
		add("r.labels @> $%d::jsonb", labels)
	}
	for pointer, value := range f.Fields {
		column, path, ok := pointerPath(pointer)
		if !ok {
			continue
		}
		args = append(args, value)
		where = append(where, fmt.Sprintf("(r.%s #>> '{%s}') = $%d", column, path, len(args)))
	}
	for _, pointer := range f.Absent {
		if column, path, ok := pointerPath(pointer); ok {
			where = append(where, fmt.Sprintf("(r.%s #> '{%s}') IS NULL", column, path))
		}
	}
	if f.UpdatedBefore != nil {
		add("r.updated_at < $%d", *f.UpdatedBefore)
	}
	if f.ReadableBy != nil {
		add(`(r.visibility = 'public' OR r.owner_pid = $%d OR EXISTS (
			SELECT 1 FROM access_index a WHERE a.pid = $%[1]d AND (a.rid = r.rid OR a.rid = r.parent_rid OR a.rid = r.project_rid)))`, *f.ReadableBy)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
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

// pointerPath turns "/status/phase" into ("status", "phase") for a #>> expression.
func pointerPath(pointer string) (column, path string, ok bool) {
	parts := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
	if len(parts) < 2 || (parts[0] != "spec" && parts[0] != "status") {
		return "", "", false
	}
	for _, p := range parts[1:] {
		if strings.ContainsAny(p, "{}',\"\\") {
			return "", "", false
		}
	}
	return parts[0], strings.Join(parts[1:], ","), true
}

// CountChildren counts the live resources with the given parent.
func (s *Store) CountChildren(ctx context.Context, parent uuid.UUID) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM resource WHERE parent_rid = $1 AND deleted_at IS NULL`, parent).Scan(&n)
	return n, err
}

// SpecUpdate is what UpdateSpec needs.
type SpecUpdate struct {
	RID  uuid.UUID
	Spec json.RawMessage
	// ExpectedHead, when set, must equal the head version (versioned kinds).
	ExpectedHead *int
	// IfMatch, when set, must equal the etag.
	IfMatch string
	// Versioned kinds get a new version with Content and Message.
	Versioned    bool
	ContentKind  string
	Content      json.RawMessage
	Message      *string
	CreatedByPID uuid.UUID
	Origin       *Origin
	// References are the edges extracted from the new content; they replace the previous
	// version's references when the kind is unversioned.
	References []Edge
}

// UpdateSpec replaces the spec and, for a versioned kind, records the new version, in one
// transaction under the resource's lock.
func (s *Store) UpdateSpec(ctx context.Context, in SpecUpdate) (*Resource, *Version, error) {
	var r *Resource
	var v *Version
	err := s.tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockResource(ctx, tx, in.RID)
		if err != nil {
			return err
		}
		if in.IfMatch != "" && in.IfMatch != cur.Etag {
			return ErrPrecondition
		}
		if in.ExpectedHead != nil && *in.ExpectedHead != cur.HeadVno {
			return fmt.Errorf("%w: head is %d, expected %d", ErrConflict, cur.HeadVno, *in.ExpectedHead)
		}
		head := cur.HeadVno
		if in.Versioned {
			head++
			v, err = insertVersion(ctx, tx, NewVersion{RID: in.RID, Vno: head, ContentKind: in.ContentKind, Content: in.Content, Message: in.Message, CreatedByPID: in.CreatedByPID, Origin: in.Origin})
			if err != nil {
				return err
			}
		}
		row := tx.QueryRow(ctx, `UPDATE resource r SET spec = $2, head_vno = $3, etag = $4, updated_at = now() WHERE r.rid = $1 RETURNING `+resourceColumns,
			in.RID, in.Spec, head, newEtag())
		r, err = scanResource(row)
		if err != nil {
			return translate(err)
		}
		return replaceReferences(ctx, tx, in.References)
	})
	if err != nil {
		return nil, nil, err
	}
	return r, v, nil
}

// MetadataUpdate is what UpdateMetadata needs; nil fields are kept.
type MetadataUpdate struct {
	RID         uuid.UUID
	Name        *string
	Description *string
	ParentRID   *uuid.UUID
	ProjectRID  *uuid.UUID
	Visibility  *string
	Labels      map[string]string
	IfMatch     string
}

// UpdateMetadata changes the metadata and keeps the tuples in step: a new parent, a change
// of visibility.
func (s *Store) UpdateMetadata(ctx context.Context, in MetadataUpdate) (*Resource, error) {
	var r *Resource
	err := s.tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockResource(ctx, tx, in.RID)
		if err != nil {
			return err
		}
		if in.IfMatch != "" && in.IfMatch != cur.Etag {
			return ErrPrecondition
		}
		name, desc, parent, project, vis, labels := cur.Name, cur.Description, cur.ParentRID, cur.ProjectRID, cur.Visibility, cur.Labels
		if in.Name != nil {
			name = *in.Name
		}
		if in.Description != nil {
			desc = in.Description
		}
		if in.ParentRID != nil && (parent == nil || *parent != *in.ParentRID) {
			if parent != nil {
				if err := enqueue(ctx, tx, "delete", object(cur.RID), "parent", object(*parent)); err != nil {
					return err
				}
			}
			if err := enqueue(ctx, tx, "write", object(cur.RID), "parent", object(*in.ParentRID)); err != nil {
				return err
			}
			parent = in.ParentRID
			if in.ProjectRID != nil {
				project = in.ProjectRID
			}
		}
		if in.Visibility != nil && *in.Visibility != vis {
			op := "delete"
			if *in.Visibility == "public" {
				op = "write"
			}
			if err := enqueue(ctx, tx, op, object(cur.RID), "viewer", "user:*"); err != nil {
				return err
			}
			vis = *in.Visibility
		}
		if in.Labels != nil {
			labels = in.Labels
		}
		labelsJSON, _ := json.Marshal(labels)
		row := tx.QueryRow(ctx, `UPDATE resource r SET name = $2, description = $3, parent_rid = $4, project_rid = $5, visibility = $6, labels = $7, etag = $8, updated_at = now()
			WHERE r.rid = $1 RETURNING `+resourceColumns, cur.RID, name, desc, parent, project, vis, labelsJSON, newEtag())
		r, err = scanResource(row)
		return translate(err)
	})
	if err != nil {
		return nil, err
	}
	return r, nil
}

// UpdateStatus replaces the status.
func (s *Store) UpdateStatus(ctx context.Context, rid uuid.UUID, status json.RawMessage) (*Resource, error) {
	row := s.pool.QueryRow(ctx, `UPDATE resource r SET status = $2, etag = $3, updated_at = now() WHERE r.rid = $1 AND r.deleted_at IS NULL RETURNING `+resourceColumns,
		rid, nullableJSON(status), newEtag())
	r, err := scanResource(row)
	return r, translate(err)
}

// MergeStatus merges fields into the status (a shallow JSON merge).
func (s *Store) MergeStatus(ctx context.Context, rid uuid.UUID, fields json.RawMessage) (*Resource, error) {
	row := s.pool.QueryRow(ctx, `UPDATE resource r SET status = coalesce(r.status, '{}'::jsonb) || $2::jsonb, etag = $3, updated_at = now()
		WHERE r.rid = $1 AND r.deleted_at IS NULL RETURNING `+resourceColumns, rid, fields, newEtag())
	r, err := scanResource(row)
	return r, translate(err)
}

// DeleteResource marks the resource deleted, drops its direct grants and reference edges, and
// enqueues the tuple deletes.
func (s *Store) DeleteResource(ctx context.Context, rid uuid.UUID) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockResource(ctx, tx, rid)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT pid, relation FROM access_index WHERE rid = $1`, rid)
		if err != nil {
			return err
		}
		grants, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (Grant, error) {
			var g Grant
			err := row.Scan(&g.PID, &g.Relation)
			return g, err
		})
		if err != nil {
			return err
		}
		for _, g := range grants {
			if err := enqueue(ctx, tx, "delete", object(rid), g.Relation, subjectOf(ctx, tx, g.PID)); err != nil {
				return err
			}
		}
		if cur.ParentRID != nil {
			if err := enqueue(ctx, tx, "delete", object(rid), "parent", object(*cur.ParentRID)); err != nil {
				return err
			}
		}
		if cur.Visibility == "public" {
			if err := enqueue(ctx, tx, "delete", object(rid), "viewer", "user:*"); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM access_index WHERE rid = $1`, rid); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM edge WHERE from_rid = $1 AND relation = 'references'`, rid); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE resource SET deleted_at = now(), etag = $2, updated_at = now() WHERE rid = $1`, rid, newEtag())
		return err
	})
}

// NewVersion is what CreateVersion needs.
type NewVersion struct {
	RID uuid.UUID
	// Vno is set by the store.
	Vno          int
	ContentKind  string
	Content      json.RawMessage
	Message      *string
	CreatedByPID uuid.UUID
	Origin       *Origin
	ExpectedHead *int
	References   []Edge
	// ClearStaging drops the staged files of the resource in the same transaction (a commit).
	ClearStaging bool
}

// CreateVersion records a new version for a kind whose content is not its spec (a manifest)
// and bumps the head.
func (s *Store) CreateVersion(ctx context.Context, in NewVersion) (*Version, error) {
	var v *Version
	err := s.tx(ctx, func(tx pgx.Tx) error {
		cur, err := lockResource(ctx, tx, in.RID)
		if err != nil {
			return err
		}
		if in.ExpectedHead != nil && *in.ExpectedHead != cur.HeadVno {
			return fmt.Errorf("%w: head is %d, expected %d", ErrConflict, cur.HeadVno, *in.ExpectedHead)
		}
		in.Vno = cur.HeadVno + 1
		v, err = insertVersion(ctx, tx, in)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE resource SET head_vno = $2, etag = $3, updated_at = now() WHERE rid = $1`, in.RID, in.Vno, newEtag()); err != nil {
			return err
		}
		if in.ClearStaging {
			if _, err := tx.Exec(ctx, `DELETE FROM dataset_staging WHERE rid = $1`, in.RID); err != nil {
				return err
			}
		}
		return replaceReferences(ctx, tx, in.References)
	})
	if err != nil {
		return nil, err
	}
	return v, nil
}

func insertVersion(ctx context.Context, tx pgx.Tx, in NewVersion) (*Version, error) {
	if len(in.Content) == 0 {
		in.Content = json.RawMessage(`{}`)
	}
	digest, err := DigestOf(in.Content)
	if err != nil {
		return nil, fmt.Errorf("content: %w", err)
	}
	origin, _ := marshalOrigin(in.Origin)
	row := tx.QueryRow(ctx, `INSERT INTO resource_version (rid, vno, content_kind, digest, content, message, created_by_pid, origin)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING rid, vno, content_kind, digest, content, message, created_by_pid, origin, created_at`,
		in.RID, in.Vno, in.ContentKind, digest, in.Content, in.Message, in.CreatedByPID, origin)
	v, err := scanVersion(row)
	return v, translate(err)
}

// GetVersion returns one version; vno <= 0 means the head.
func (s *Store) GetVersion(ctx context.Context, rid uuid.UUID, vno int) (*Version, error) {
	var row pgx.Row
	if vno <= 0 {
		row = s.pool.QueryRow(ctx, `SELECT v.rid, v.vno, v.content_kind, v.digest, v.content, v.message, v.created_by_pid, v.origin, v.created_at
			FROM resource_version v JOIN resource r ON r.rid = v.rid WHERE v.rid = $1 AND v.vno = r.head_vno AND r.deleted_at IS NULL`, rid)
	} else {
		row = s.pool.QueryRow(ctx, `SELECT v.rid, v.vno, v.content_kind, v.digest, v.content, v.message, v.created_by_pid, v.origin, v.created_at
			FROM resource_version v JOIN resource r ON r.rid = v.rid WHERE v.rid = $1 AND v.vno = $2 AND r.deleted_at IS NULL`, rid, vno)
	}
	v, err := scanVersion(row)
	return v, translate(err)
}

// ListVersions returns versions newest first, without their content.
func (s *Store) ListVersions(ctx context.Context, rid uuid.UUID, limit, offset int) ([]Version, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT v.rid, v.vno, v.content_kind, v.digest, 'null'::jsonb, v.message, v.created_by_pid, v.origin, v.created_at
		FROM resource_version v WHERE v.rid = $1 ORDER BY v.vno DESC LIMIT $2 OFFSET $3`, rid, limit, offset)
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
		v.Content = nil
		out = append(out, *v)
	}
	return out, rows.Err()
}

func lockResource(ctx context.Context, tx pgx.Tx, rid uuid.UUID) (*Resource, error) {
	row := tx.QueryRow(ctx, `SELECT `+resourceColumns+` FROM resource r WHERE r.rid = $1 AND r.deleted_at IS NULL FOR UPDATE`, rid)
	r, err := scanResource(row)
	return r, translate(err)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanResource(row scanner) (*Resource, error) {
	var r Resource
	var labels, origin []byte
	var status []byte
	if err := row.Scan(&r.RID, &r.Kind, &r.Name, &r.Description, &r.ParentRID, &r.ProjectRID, &r.OwnerPID, &r.Visibility,
		&labels, &r.Spec, &status, &r.HeadVno, &r.Etag, &r.CreatedByPID, &origin, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	r.Labels = map[string]string{}
	_ = json.Unmarshal(labels, &r.Labels)
	if len(status) > 0 {
		r.Status = json.RawMessage(status)
	}
	r.Origin = unmarshalOrigin(origin)
	return &r, nil
}

func scanVersion(row scanner) (*Version, error) {
	var v Version
	var origin []byte
	if err := row.Scan(&v.RID, &v.Vno, &v.ContentKind, &v.Digest, &v.Content, &v.Message, &v.CreatedByPID, &origin, &v.CreatedAt); err != nil {
		return nil, err
	}
	v.Origin = unmarshalOrigin(origin)
	return &v, nil
}

func marshalOrigin(o *Origin) ([]byte, error) {
	if o == nil {
		return nil, nil
	}
	return json.Marshal(o)
}

func unmarshalOrigin(raw []byte) *Origin {
	if len(raw) == 0 {
		return nil
	}
	var o Origin
	if err := json.Unmarshal(raw, &o); err != nil || o.Conversation == uuid.Nil {
		return nil
	}
	return &o
}

func nullableJSON(raw json.RawMessage) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}

// ErrReferenced is returned when a delete is refused because live resources reference it.
var ErrReferenced = errors.New("referenced")
