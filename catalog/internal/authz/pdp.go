// Package authz is the policy decision point: every operation names a permission
// (permissions.gen.go), and a decision is a Check against the Authorizer port. Administrators
// and the platform's service identity pass; everyone else is a relationship question.
package authz

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/ports"
)

// The permissions operations name; each is a computed relation of the model.
const (
	Read    = "read"
	Write   = "write"
	Share   = "share"
	Delete  = "delete"
	Execute = "execute"
	Use     = "use"
	RunOn   = "run_on"
	Rotate  = "rotate"
)

// Resource permissions are the ones checked on a resource; the rest (list, create, self,
// service, admin, public) are decided by the operation itself.
var resourcePermissions = map[string]bool{Read: true, Write: true, Share: true, Delete: true, Execute: true, Use: true, RunOn: true, Rotate: true}

// IsResourcePermission reports whether a permission is checked against a resource.
func IsResourcePermission(p string) bool { return resourcePermissions[p] }

// ErrForbidden is returned when a decision is negative.
var ErrForbidden = errors.New("forbidden")

// PDP decides access.
type PDP struct {
	authorizer ports.Authorizer
	log        *slog.Logger
}

// NewPDP builds a decision point.
func NewPDP(a ports.Authorizer, log *slog.Logger) *PDP {
	return &PDP{authorizer: a, log: log}
}

// Allowed reports whether the caller holds the permission on the resource.
func (p *PDP) Allowed(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) (bool, error) {
	if caller == nil || caller.Principal == nil {
		return false, nil
	}
	if caller.Service || caller.Admin() {
		return true, nil
	}
	if !IsResourcePermission(permission) {
		return false, fmt.Errorf("permission %q is not checked on a resource", permission)
	}
	return p.authorizer.Check(ctx, "user:"+caller.PID().String(), "can_"+permission, "resource:"+rid.String())
}

// Require returns ErrForbidden unless Allowed.
func (p *PDP) Require(ctx context.Context, caller *auth.Caller, permission string, rid uuid.UUID) error {
	ok, err := p.Allowed(ctx, caller, permission, rid)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	return nil
}

// Relay moves outbox entries into the authorizer.
type Relay struct {
	outbox     Outbox
	authorizer ports.Authorizer
	log        *slog.Logger
	wake       chan struct{}
}

// Outbox is what the relay reads: the store's pending tuples.
type Outbox interface {
	PendingOutbox(ctx context.Context, limit int) ([]OutboxEntry, error)
	MarkOutboxProcessed(ctx context.Context, ids []int64) error
}

// OutboxEntry mirrors store.OutboxEntry without importing the store.
type OutboxEntry struct {
	ID       int64
	Op       string
	Object   string
	Relation string
	Subject  string
}

// NewRelay builds a relay; call Run in a goroutine and Kick after writes.
func NewRelay(outbox Outbox, a ports.Authorizer, log *slog.Logger) *Relay {
	return &Relay{outbox: outbox, authorizer: a, log: log, wake: make(chan struct{}, 1)}
}

// Kick asks the relay to run soon.
func (r *Relay) Kick() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Flush applies every pending entry now, so a resource created in a request is visible to
// the authorizer before the request answers; a failure is logged and retried by Run.
func (r *Relay) Flush(ctx context.Context) {
	if err := r.Once(ctx); err != nil {
		r.log.Warn("outbox flush failed; the relay retries", "err", err)
		r.Kick()
	}
}

// Once applies every pending entry.
func (r *Relay) Once(ctx context.Context) error {
	for {
		entries, err := r.outbox.PendingOutbox(ctx, 200)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		var writes, deletes []ports.Tuple
		ids := make([]int64, 0, len(entries))
		for _, e := range entries {
			t := ports.Tuple{Object: e.Object, Relation: e.Relation, Subject: e.Subject}
			if e.Op == "delete" {
				deletes = append(deletes, t)
			} else {
				writes = append(writes, t)
			}
			ids = append(ids, e.ID)
		}
		if err := r.authorizer.Write(ctx, writes, deletes); err != nil {
			return err
		}
		if err := r.outbox.MarkOutboxProcessed(ctx, ids); err != nil {
			return err
		}
		if len(entries) < 200 {
			return nil
		}
	}
}

// Run relays on a timer and on kicks until the context ends.
func (r *Relay) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = 2 * time.Second
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := r.Once(ctx); err != nil && ctx.Err() == nil {
			r.log.Warn("outbox relay failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-r.wake:
		}
	}
}
