package authz

import (
	"context"
	"errors"
	"log/slog"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/store"
)

// Action is what a caller wants to do with a resource.
type Action string

// The actions the catalog decides on.
const (
	ActionRead   Action = "read"
	ActionWrite  Action = "write"
	ActionShare  Action = "share"
	ActionDelete Action = "delete"
)

func (a Action) relation() string {
	switch a {
	case ActionRead:
		return "viewer"
	case ActionWrite:
		return "editor"
	default:
		return "owner"
	}
}

func (a Action) fgaRelation() string {
	switch a {
	case ActionRead:
		return "can_read"
	case ActionWrite:
		return "can_write"
	case ActionShare:
		return "can_share"
	default:
		return "can_delete"
	}
}

// ErrForbidden is returned when a decision is negative.
var ErrForbidden = errors.New("forbidden")

// PDP decides access. The catalog's grants are authoritative and consistent; OpenFGA is the
// secondary path that also knows group memberships and inherited relations written
// outside the catalog. Either saying yes allows.
type PDP struct {
	store *store.Store
	fga   *FGA
	log   *slog.Logger
}

// NewPDP builds a decision point; fga may be nil (grants only).
func NewPDP(st *store.Store, fga *FGA, log *slog.Logger) *PDP {
	return &PDP{store: st, fga: fga, log: log}
}

// Allowed reports whether the caller may perform the action on the resource. An agent
// acting for a user is allowed when the user is, or when the agent itself holds the relation
// (agents are granted editor on their own conversation).
func (p *PDP) Allowed(ctx context.Context, caller *authn.Caller, action Action, rid uuid.UUID) (bool, error) {
	if caller == nil || caller.Principal == nil {
		return false, nil
	}
	if caller.IsService && caller.Agent == nil {
		// The platform's own service identity (units reporting, the runtime's bookkeeping).
		return true, nil
	}
	subjects := []uuid.UUID{caller.Principal.PID}
	if caller.Agent != nil {
		subjects = append(subjects, caller.Agent.PID)
	}
	for _, pid := range subjects {
		ok, err := p.store.HasRelation(ctx, rid, pid, action.relation())
		if err != nil {
			return false, err
		}
		if ok {
			return true, nil
		}
	}
	if p.fga != nil {
		for i, pid := range subjects {
			subjectType := "user"
			if i == 1 {
				subjectType = "agent"
			}
			ok, err := p.fga.Check(ctx, subjectType+":"+pid.String(), action.fgaRelation(), "resource:"+rid.String())
			if err != nil {
				p.log.Warn("openfga check failed; grants decided", "err", err)
				return false, nil
			}
			if ok {
				return true, nil
			}
		}
	}
	return false, nil
}

// Require returns ErrForbidden unless Allowed.
func (p *PDP) Require(ctx context.Context, caller *authn.Caller, action Action, rid uuid.UUID) error {
	ok, err := p.Allowed(ctx, caller, action, rid)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	return nil
}
