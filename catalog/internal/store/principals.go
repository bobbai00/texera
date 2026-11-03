package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const principalColumns = `pid, kind, display_name, subject, email, sponsor_pid, created_at`

func scanPrincipal(row pgx.Row) (*Principal, error) {
	var p Principal
	if err := row.Scan(&p.PID, &p.Kind, &p.DisplayName, &p.Subject, &p.Email, &p.SponsorPID, &p.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	return &p, nil
}

// GetPrincipal returns a principal by id.
func (s *Store) GetPrincipal(ctx context.Context, pid uuid.UUID) (*Principal, error) {
	return scanPrincipal(s.pool.QueryRow(ctx, `SELECT `+principalColumns+` FROM principal WHERE pid = $1`, pid))
}

// GetPrincipalBySubject returns the principal bound to an OIDC subject.
func (s *Store) GetPrincipalBySubject(ctx context.Context, subject string) (*Principal, error) {
	return scanPrincipal(s.pool.QueryRow(ctx, `SELECT `+principalColumns+` FROM principal WHERE subject = $1`, subject))
}

// CreatePrincipal inserts a principal; PID is generated when zero.
func (s *Store) CreatePrincipal(ctx context.Context, p Principal) (*Principal, error) {
	if p.PID == uuid.Nil {
		p.PID = uuid.New()
	}
	return scanPrincipal(s.pool.QueryRow(ctx, `INSERT INTO principal (pid, kind, display_name, subject, email, sponsor_pid)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+principalColumns,
		p.PID, p.Kind, p.DisplayName, p.Subject, p.Email, p.SponsorPID))
}

// EnsureUser returns the user principal for an OIDC subject, creating it on first sight.
func (s *Store) EnsureUser(ctx context.Context, subject, displayName string, email *string) (*Principal, bool, error) {
	if p, err := s.GetPrincipalBySubject(ctx, subject); err == nil {
		return p, false, nil
	} else if err != ErrNotFound {
		return nil, false, err
	}
	p, err := s.CreatePrincipal(ctx, Principal{Kind: "user", DisplayName: displayName, Subject: &subject, Email: email})
	if err != nil {
		// A concurrent first login may have won the race.
		if existing, err2 := s.GetPrincipalBySubject(ctx, subject); err2 == nil {
			return existing, false, nil
		}
		return nil, false, fmt.Errorf("create user principal: %w", err)
	}
	return p, true, nil
}

// SearchPrincipals lists principals by name prefix and kind.
func (s *Store) SearchPrincipals(ctx context.Context, q string, kind string, limit int) ([]Principal, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT `+principalColumns+` FROM principal
		WHERE ($1 = '' OR display_name ILIKE $1 || '%' OR email ILIKE $1 || '%')
		  AND ($2 = '' OR kind = $2)
		ORDER BY display_name LIMIT $3`, q, kind, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Principal
	for rows.Next() {
		var p Principal
		if err := rows.Scan(&p.PID, &p.Kind, &p.DisplayName, &p.Subject, &p.Email, &p.SponsorPID, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
