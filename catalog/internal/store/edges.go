package store

import (
	"context"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const edgeColumns = `e.from_uri, e.relation, e.to_uri, e.from_rid, e.to_rid, e.field, e.execution_rid, e.attrs, e.at`

// replaceReferences replaces the `references` edges recorded under the given names and under
// every from_uri present in edges. Naming the source matters when the new content references
// nothing: its old references go, and what it named is free again.
func replaceReferences(ctx context.Context, tx pgx.Tx, edges []Edge, sources ...string) error {
	froms := map[string]bool{}
	for _, from := range sources {
		if from != "" {
			froms[from] = true
		}
	}
	for _, e := range edges {
		if e.Relation == "references" {
			froms[e.From] = true
		}
	}
	for from := range froms {
		if _, err := tx.Exec(ctx, `DELETE FROM edge WHERE from_uri = $1 AND relation = 'references'`, from); err != nil {
			return err
		}
	}
	return insertEdges(ctx, tx, edges)
}

func insertEdges(ctx context.Context, tx pgx.Tx, edges []Edge) error {
	for _, e := range edges {
		if _, err := tx.Exec(ctx, `INSERT INTO edge (from_uri, relation, to_uri, from_rid, to_rid, field, execution_rid, attrs)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (from_uri, relation, to_uri) DO UPDATE SET field = EXCLUDED.field, execution_rid = EXCLUDED.execution_rid, attrs = EXCLUDED.attrs, at = now()`,
			e.From, e.Relation, e.To, e.FromRID, e.ToRID, e.Field, e.ExecutionRID, nullableJSON(e.Attrs)); err != nil {
			return err
		}
	}
	return nil
}

// AddEdges records runtime lineage arrows (idempotent per arrow).
func (s *Store) AddEdges(ctx context.Context, edges []Edge) error {
	return s.tx(ctx, func(tx pgx.Tx) error { return insertEdges(ctx, tx, edges) })
}

// ReplaceReferences replaces the reference edges of the given from URIs.
func (s *Store) ReplaceReferences(ctx context.Context, edges []Edge) error {
	return s.tx(ctx, func(tx pgx.Tx) error { return replaceReferences(ctx, tx, edges) })
}

// EdgesFrom returns the arrows leaving a URI, or any of its versions and subresources when
// the URI names a resource or a version.
func (s *Store) EdgesFrom(ctx context.Context, uri string, relations []string) ([]Edge, error) {
	return s.queryEdges(ctx, `e.from_uri = $1 OR e.from_uri LIKE $2 OR e.from_uri LIKE $3`, uri, relations)
}

// ReferencesFrom returns what these exact URIs name: the references their content records.
func (s *Store) ReferencesFrom(ctx context.Context, uris []string) ([]Edge, error) {
	if len(uris) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT `+edgeColumns+` FROM edge e WHERE e.relation = 'references' AND e.from_uri = ANY($1)
		ORDER BY e.at, e.from_uri, e.to_uri`, uris)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, scanEdge)
}

// EdgesTo returns the arrows arriving at a URI, its versions or its subresources.
func (s *Store) EdgesTo(ctx context.Context, uri string, relations []string) ([]Edge, error) {
	return s.queryEdges(ctx, `e.to_uri = $1 OR e.to_uri LIKE $2 OR e.to_uri LIKE $3`, uri, relations)
}

func (s *Store) queryEdges(ctx context.Context, match, uri string, relations []string) ([]Edge, error) {
	like := escapeLike(uri)
	args := []any{uri, like + "@%", like + "/%"}
	sql := `SELECT ` + edgeColumns + ` FROM edge e WHERE (` + match + `)`
	if len(relations) > 0 {
		args = append(args, relations)
		sql += ` AND e.relation = ANY($4)`
	}
	sql += ` ORDER BY e.at, e.from_uri, e.to_uri`
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, scanEdge)
}

// Dependents returns the live resources whose versions reference the resource (or one
// version of it when vno > 0).
func (s *Store) Dependents(ctx context.Context, rid uuid.UUID, vno int) ([]Edge, error) {
	sql := `SELECT ` + edgeColumns + ` FROM edge e JOIN resource r ON r.rid = e.from_rid
		WHERE e.relation = 'references' AND e.to_rid = $1 AND r.deleted_at IS NULL`
	args := []any{rid}
	if vno > 0 {
		args = append(args, "%@"+strconv.Itoa(vno), "%@"+strconv.Itoa(vno)+"/%")
		sql += ` AND (e.to_uri LIKE $2 OR e.to_uri LIKE $3)`
	}
	sql += ` ORDER BY e.at`
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return pgx.CollectRows(rows, scanEdge)
}

// Walk follows arrows from a URI. Upstream answers "where did this come from": the inputs
// an execution used, the port a version was derived from and that port's execution, the
// resources a version references. Downstream answers "what was made from this": the
// executions that used it, the versions derived from its ports, the versions that reference
// it. A node and its versions and subresources count as one, so a dataset reaches the arrows
// of its files and an execution the arrows of its ports. Depth bounds the walk.
func (s *Store) Walk(ctx context.Context, root string, upstream, downstream bool, depth int) ([]Edge, error) {
	if depth <= 0 || depth > 8 {
		depth = 4
	}
	seen := map[string]bool{}
	var out []Edge
	frontier := []string{root}
	visit := func(next *[]string, node string) {
		*next = append(*next, node)
		if ex := executionOf(node); ex != node {
			*next = append(*next, ex)
		}
	}
	for level := 0; level < depth && len(frontier) > 0; level++ {
		var next []string
		for _, node := range frontier {
			if seen[node] {
				continue
			}
			seen[node] = true
			if upstream {
				from, err := s.EdgesFrom(ctx, node, []string{"used", "derivedFrom", "references", "reused"})
				if err != nil {
					return nil, err
				}
				for _, e := range from {
					out = append(out, e)
					visit(&next, e.To)
				}
				if isPort(node) {
					produced, err := s.EdgesFrom(ctx, node, []string{"produced"})
					if err != nil {
						return nil, err
					}
					out = append(out, produced...)
				}
			}
			if downstream {
				to, err := s.EdgesTo(ctx, node, []string{"used", "derivedFrom", "references", "reused"})
				if err != nil {
					return nil, err
				}
				for _, e := range to {
					out = append(out, e)
					visit(&next, e.From)
				}
				produced, err := s.EdgesFrom(ctx, node, []string{"produced"})
				if err != nil {
					return nil, err
				}
				out = append(out, produced...)
			}
		}
		frontier = next
	}
	return dedupe(out), nil
}

func isPort(uri string) bool {
	return strings.Contains(uri, "/operators/") && strings.Contains(uri, "/ports/")
}

// executionOf trims a port URI to its execution.
func executionOf(portURI string) string {
	if i := strings.Index(portURI, "/operators/"); i > 0 {
		return portURI[:i]
	}
	return portURI
}

func dedupe(edges []Edge) []Edge {
	seen := map[string]bool{}
	var out []Edge
	for _, e := range edges {
		key := e.From + "|" + e.Relation + "|" + e.To
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
	}
	return out
}

func scanEdge(row pgx.CollectableRow) (Edge, error) {
	var e Edge
	var attrs []byte
	err := row.Scan(&e.From, &e.Relation, &e.To, &e.FromRID, &e.ToRID, &e.Field, &e.ExecutionRID, &attrs, &e.At)
	if len(attrs) > 0 {
		e.Attrs = attrs
	}
	return e, err
}

func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	return strings.ReplaceAll(s, `_`, `\_`)
}
