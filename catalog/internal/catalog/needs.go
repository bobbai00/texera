package catalog

// What a person needs to open what a resource uses, for the one sharing it with them. What it
// uses is what its head version names, of the kinds that hold data or code: the datasets a
// workflow reads, its custom operators. The unit or the warehouse it names is where it runs, not
// what it uses: whoever opens it runs on their own.

import (
	"context"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

// Needed is something a resource uses that a person cannot open.
type Needed struct {
	Resource store.Resource
	// Shareable is true when the caller may share it, and so open it to the person in one step.
	Shareable bool
}

// Needs lists what a resource uses that a principal may not read, of what the caller may read:
// nobody learns of something they cannot see themselves.
func (s *Service) Needs(ctx context.Context, caller *auth.Caller, rid, principal uuid.UUID) ([]Needed, error) {
	r, err := s.Get(ctx, caller, nil, rid)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, caller, authz.Share, rid); err != nil {
		return nil, err
	}
	from := URI(r)
	if k, _ := kinds.ByName(r.Kind); k.Versioned && r.HeadVno > 0 {
		from = from.WithVersion(r.HeadVno)
	}
	edges, err := s.Store.ReferencesFrom(ctx, []string{from.String()})
	if err != nil {
		return nil, err
	}
	whom, err := s.Store.GetPrincipal(ctx, principal)
	if err != nil {
		return nil, NotFound("principal " + principal.String())
	}
	subject := "user:" + principal.String()
	if whom.Kind == "group" {
		subject = "group:" + principal.String() + "#member"
	}
	seen := map[uuid.UUID]bool{}
	var out []Needed
	for _, e := range edges {
		if e.ToRID == nil || seen[*e.ToRID] {
			continue
		}
		seen[*e.ToRID] = true
		used, err := s.Store.GetResource(ctx, *e.ToRID)
		if err != nil {
			continue
		}
		if k, _ := kinds.ByName(used.Kind); !k.Versioned || s.decide(ctx, caller, authz.Read, used.RID) != nil {
			continue
		}
		readable, err := s.PDP.AllowedFor(ctx, subject, authz.Read, used.RID)
		if err != nil {
			return nil, err
		}
		if !readable {
			out = append(out, Needed{Resource: *used, Shareable: s.require(ctx, caller, authz.Share, used.RID) == nil})
		}
	}
	return out, nil
}
