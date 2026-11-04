package store

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const principalColumns = `pid, kind, display_name, subject, email, admin, preferences, created_at, updated_at`

// EnsureUser finds or creates the user with the given subject and refreshes what the token
// says about them; it reports whether the user is new.
func (s *Store) EnsureUser(ctx context.Context, subject, displayName, email string, admin bool) (*Principal, bool, error) {
	var created bool
	row := s.pool.QueryRow(ctx, `INSERT INTO principal (kind, display_name, subject, email, admin) VALUES ('user', $1, $2, nullif($3, ''), $4)
		ON CONFLICT (subject) DO UPDATE SET display_name = EXCLUDED.display_name, email = coalesce(EXCLUDED.email, principal.email), admin = EXCLUDED.admin, updated_at = now()
		RETURNING `+principalColumns+`, (xmax = 0)`, displayName, subject, email, admin)
	p, err := scanPrincipalCreated(row, &created)
	if err != nil {
		return nil, false, err
	}
	return p, created, nil
}

// EnsureGroup finds or creates a group by name (its subject is "group:<name>").
func (s *Store) EnsureGroup(ctx context.Context, name string) (*Principal, error) {
	var created bool
	row := s.pool.QueryRow(ctx, `INSERT INTO principal (kind, display_name, subject) VALUES ('group', $1, $2)
		ON CONFLICT (subject) DO UPDATE SET updated_at = now() RETURNING `+principalColumns+`, (xmax = 0)`, name, "group:"+name)
	return scanPrincipalCreated(row, &created)
}

// GetPrincipal returns one principal.
func (s *Store) GetPrincipal(ctx context.Context, pid uuid.UUID) (*Principal, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+principalColumns+` FROM principal p WHERE p.pid = $1`, pid)
	p, err := scanPrincipal(row)
	return p, translate(err)
}

// GetPrincipalBySubject returns the principal with the given subject.
func (s *Store) GetPrincipalBySubject(ctx context.Context, subject string) (*Principal, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+principalColumns+` FROM principal p WHERE p.subject = $1`, subject)
	p, err := scanPrincipal(row)
	return p, translate(err)
}

// SearchPrincipals finds principals by name or email.
func (s *Store) SearchPrincipals(ctx context.Context, q, kind string, limit int) ([]Principal, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	q = strings.TrimSpace(q)
	rows, err := s.pool.Query(ctx, `SELECT `+principalColumns+` FROM principal p
		WHERE ($1 = '' OR p.kind = $1) AND ($2 = '' OR lower(p.display_name) LIKE '%' || lower($2) || '%' OR lower(coalesce(p.email, '')) LIKE '%' || lower($2) || '%')
		AND coalesce(p.subject, '') NOT LIKE 'system:%'
		ORDER BY p.display_name LIMIT $3`, kind, q, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Principal
	for rows.Next() {
		p, err := scanPrincipal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// UpdatePreferences replaces a principal's preferences.
func (s *Store) UpdatePreferences(ctx context.Context, pid uuid.UUID, prefs json.RawMessage) (*Principal, error) {
	if len(prefs) == 0 {
		prefs = json.RawMessage(`{}`)
	}
	row := s.pool.QueryRow(ctx, `UPDATE principal p SET preferences = $2, updated_at = now() WHERE p.pid = $1 RETURNING `+principalColumns, pid, prefs)
	p, err := scanPrincipal(row)
	return p, translate(err)
}

func scanPrincipal(row scanner) (*Principal, error) {
	var p Principal
	if err := row.Scan(&p.PID, &p.Kind, &p.DisplayName, &p.Subject, &p.Email, &p.Admin, &p.Preferences, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	return &p, nil
}

func scanPrincipalCreated(row pgx.Row, created *bool) (*Principal, error) {
	var p Principal
	if err := row.Scan(&p.PID, &p.Kind, &p.DisplayName, &p.Subject, &p.Email, &p.Admin, &p.Preferences, &p.CreatedAt, &p.UpdatedAt, created); err != nil {
		return nil, translate(err)
	}
	return &p, nil
}
