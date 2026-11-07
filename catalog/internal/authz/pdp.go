// Package authz is the policy decision point: every operation names a permission
// (permissions.gen.go), and a decision is a Check against the Authorizer port. The platform's
// service identity passes; everyone else, a project's admins included, is a relationship
// question.
package authz

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
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
	// Admin changes a project itself: its settings, what it inherits from, its people.
	Admin = "admin"
)

// Resource permissions are the ones checked on a resource; the rest (list, create, self,
// service, public) are decided by the operation itself.
var resourcePermissions = map[string]bool{Read: true, Write: true, Share: true, Delete: true, Execute: true, Use: true, RunOn: true, Rotate: true, Admin: true}

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
	if caller.Service {
		return true, nil
	}
	if !IsResourcePermission(permission) {
		return false, fmt.Errorf("permission %q is not checked on a resource", permission)
	}
	return p.authorizer.Check(ctx, "user:"+caller.PID().String(), "can_"+permission, "resource:"+rid.String())
}

// AllowedFor reports whether a principal other than the caller holds the permission, as the
// authorizer decides it for them: for telling someone what a person or a group they share with
// can open. The principal is named as its grants name it: user:<pid> or group:<pid>#member.
func (p *PDP) AllowedFor(ctx context.Context, subject, permission string, rid uuid.UUID) (bool, error) {
	if !IsResourcePermission(permission) {
		return false, fmt.Errorf("permission %q is not checked on a resource", permission)
	}
	return p.authorizer.Check(ctx, subject, "can_"+permission, "resource:"+rid.String())
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

// Relay moves outbox entries into the authorizer, one relay at a time and in the order the
// entries were made.
type Relay struct {
	outbox     Outbox
	authorizer ports.Authorizer
	log        *slog.Logger
	wake       chan struct{}
	// mu lets one relay run at a time. A request that changes a grant relays before it
	// answers, and a timer relays what a failure left: without it two of them send the same
	// entries, and one returns before its own are applied.
	mu sync.Mutex
}

// Outbox is what the relay reads: the store's pending tuples, and every tuple its index of
// grants implies.
type Outbox interface {
	PendingOutbox(ctx context.Context, limit int) ([]OutboxEntry, error)
	MarkOutboxProcessed(ctx context.Context, ids []int64) error
	AllTuples(ctx context.Context) ([]OutboxEntry, error)
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

// Once applies every pending entry, after a relay that is under way.
func (r *Relay) Once(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.drain(ctx)
}

// drain applies the pending entries batch by batch; the caller holds mu.
func (r *Relay) drain(ctx context.Context) error {
	for {
		entries, err := r.outbox.PendingOutbox(ctx, 200)
		if err != nil {
			return err
		}
		if len(entries) == 0 {
			return nil
		}
		ids := make([]int64, 0, len(entries))
		for _, e := range entries {
			ids = append(ids, e.ID)
		}
		writes, deletes := lastWords(entries)
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

// lastWords reduces a batch to what it leaves of each tuple. Entries are applied in the order
// they were made, so of several about one tuple (shared and taken back at once) the newest
// stands; the authorizer takes a tuple once per request.
func lastWords(entries []OutboxEntry) (writes, deletes []ports.Tuple) {
	last := map[ports.Tuple]string{}
	var order []ports.Tuple
	for _, e := range entries {
		t := ports.Tuple{Object: e.Object, Relation: e.Relation, Subject: e.Subject}
		if _, seen := last[t]; !seen {
			order = append(order, t)
		}
		last[t] = e.Op
	}
	for _, t := range order {
		if last[t] == "delete" {
			deletes = append(deletes, t)
		} else {
			writes = append(writes, t)
		}
	}
	return writes, deletes
}

// Rebuild writes every tuple the catalog's index implies, after what is still pending, and
// says how many. The authorizer is a copy of that index: a rebuild puts back what a relay
// lost and adds nothing the index does not hold. No relay runs meanwhile, so a grant taken
// back while the rebuild writes is taken back after it, not written back by it.
func (r *Relay) Rebuild(ctx context.Context) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.drain(ctx); err != nil {
		return 0, err
	}
	entries, err := r.outbox.AllTuples(ctx)
	if err != nil {
		return 0, err
	}
	const batch = 500
	for start := 0; start < len(entries); start += batch {
		writes := make([]ports.Tuple, 0, batch)
		for _, e := range entries[start:min(start+batch, len(entries))] {
			writes = append(writes, ports.Tuple{Object: e.Object, Relation: e.Relation, Subject: e.Subject})
		}
		if err := r.authorizer.Write(ctx, writes, nil); err != nil {
			return start, err
		}
	}
	return len(entries), nil
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
