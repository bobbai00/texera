// Package store is the catalog's own memory: one Postgres schema with the envelope of every
// kind, the versions, the grant index and outbox, blobs and staging, the edge index,
// messages and leases. It speaks plain Go types; the services map them to the contract.
//
// Rules the schema keeps: a secret value never lands here; a peer's state is referenced by
// id (the OIDC subject, a blob digest, a snapshot id) and never copied; the edge table and the
// access index are rebuildable from the versions, the events and OpenFGA.
package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

var (
	// ErrNotFound is returned when a row does not exist or is deleted.
	ErrNotFound = errors.New("not found")
	// ErrConflict is returned when an optimistic check fails: the head moved, a turn is
	// active, or a name is taken.
	ErrConflict = errors.New("conflict")
	// ErrPrecondition is returned when If-Match does not match the current etag.
	ErrPrecondition = errors.New("precondition failed")
)

// Store wraps a connection pool.
type Store struct {
	pool *pgxpool.Pool
	// OnChange, when set, is called after every committed write to a resource row or to a
	// conversation's messages (grants and edges excepted), on the writer's goroutine; it must
	// not block. The catalog's broker hands the change to the resource's watchers.
	OnChange func(Change)
}

// Change is one write to a resource, for whoever watches it: the resource itself changed
// (spec, status or metadata), a message of a conversation was appended or rewritten, or the
// resource was deleted.
type Change struct {
	RID     uuid.UUID
	Message *Message
	Deleted bool
}

func (s *Store) changed(c Change) {
	if s.OnChange != nil {
		s.OnChange(c)
	}
}

// Open connects to Postgres.
func Open(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Pool exposes the pool for tests.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Migrate applies the embedded migrations in lexical order, once each.
func (s *Store) Migrate(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migration (
		name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("create schema_migration: %w", err)
	}
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		var n int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM schema_migration WHERE name = $1`, name).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if err := s.tx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, string(body)); err != nil {
				return fmt.Errorf("apply %s: %w", name, err)
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migration (name) VALUES ($1)`, name)
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// Reset drops every table; only for tests.
func (s *Store) Reset(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`)
	return err
}

func (s *Store) tx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// translate maps driver errors to the store's errors.
func translate(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
		return fmt.Errorf("%w: %s", ErrConflict, pgErr.ConstraintName)
	}
	return err
}

// IsNotFound reports whether err is ErrNotFound.
func IsNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

// IsConflict reports whether err is ErrConflict.
func IsConflict(err error) bool { return errors.Is(err, ErrConflict) }
