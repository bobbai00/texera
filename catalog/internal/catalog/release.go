package catalog

// What a release puts into Texera. Texera is a project like any other, changed by its admins, and
// a release brings what it ships into it without undoing them. The ledger (store.Shipped) keeps,
// for each kind and name a release ships, the resource and the digest of what the release last
// wrote of it, its spec and its description:
//
//   - nothing recorded: the release makes the resource, or takes up the one a release before the
//     ledger made under that name, and records it;
//   - recorded, and the resource is still as written: the release writes what it ships now;
//   - recorded, and the resource differs: Texera's admins changed it, and it stays as they left it;
//   - recorded, and the resource is gone: they deleted it, and it stays gone.
//
// What an earlier release shipped and this one does not goes when nobody changed it; either way
// the ledger forgets it.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
)

// shipment is one resource a release ships into Texera.
type shipment struct {
	kind, name, description string
	spec, status            json.RawMessage
	// message is recorded on the version an update makes.
	message string
	// typed: the resource is an operator, found by the type its spec names rather than by name.
	typed bool
	// rid, when set, is the id a new resource gets: for what must be known before it is made.
	rid *uuid.UUID
}

// ShippedDigest is what the ledger compares: a resource's spec and description.
func ShippedDigest(spec json.RawMessage, description *string) string {
	canonical, _ := store.Canonical(spec)
	h := sha256.New()
	h.Write(canonical)
	h.Write([]byte{0})
	if description != nil {
		h.Write([]byte(*description))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ship brings one shipped resource into Texera, and returns it; nil when Texera's admins deleted
// it.
func (s *Service) ship(ctx context.Context, caller *auth.Caller, in shipment) (*store.Resource, error) {
	root := s.Root()
	if root == nil {
		return nil, errors.New("ship before the seed")
	}
	k, ok := kinds.ByName(in.kind)
	if !ok {
		return nil, fmt.Errorf("unknown kind %s", in.kind)
	}
	var r *store.Resource
	led, err := s.Store.GetShipped(ctx, in.kind, in.name)
	switch {
	case err == nil:
		r, err = s.Store.GetResource(ctx, led.RID)
		if store.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if ShippedDigest(r.Spec, r.Description) != led.Digest {
			if len(in.status) > 0 {
				return s.Store.MergeStatus(ctx, r.RID, in.status)
			}
			return r, nil
		}
	case store.IsNotFound(err):
		if r, err = s.shippedBefore(ctx, root, in); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	desc := in.description
	if r == nil {
		owner := caller.PID()
		r, _, err = s.Create(ctx, caller, CreateInput{Kind: k, RID: in.rid, Name: in.name, Description: &desc, Parent: &root.RID, Spec: in.spec, Status: in.status, Owner: &owner})
		if err != nil {
			return nil, fmt.Errorf("ship %s %s: %w", in.kind, in.name, err)
		}
		s.Log.Info("shipped", "kind", in.kind, "name", in.name, "rid", r.RID)
	} else {
		if r.Description == nil || *r.Description != desc {
			if r, err = s.Store.UpdateMetadata(ctx, store.MetadataUpdate{RID: r.RID, Description: &desc}); err != nil {
				return nil, err
			}
		}
		cur, _ := store.Canonical(r.Spec)
		next, _ := store.Canonical(in.spec)
		if string(cur) != string(next) {
			message := in.message
			if message == "" {
				message = "updated by the release"
			}
			if r, _, err = s.UpdateSpec(ctx, caller, k, UpdateSpecInput{RID: r.RID, Spec: in.spec, Message: &message}); err != nil {
				return nil, fmt.Errorf("update %s %s: %w", in.kind, in.name, err)
			}
			s.Log.Info("updated by the release", "kind", in.kind, "name", in.name, "rid", r.RID)
		}
		if len(in.status) > 0 {
			if r, err = s.Store.MergeStatus(ctx, r.RID, in.status); err != nil {
				return nil, err
			}
		}
	}
	if err := s.Store.RecordShipped(ctx, store.Shipped{Kind: in.kind, Name: in.name, RID: r.RID, Digest: ShippedDigest(r.Spec, r.Description)}); err != nil {
		return nil, err
	}
	return r, nil
}

// shippedBefore finds what a release made under a name before the ledger kept it: the platform's
// own resource of that kind and name in Texera.
func (s *Service) shippedBefore(ctx context.Context, root *store.Resource, in shipment) (*store.Resource, error) {
	sys := s.System()
	if sys == nil {
		return nil, nil
	}
	named, err := s.Store.ListResources(ctx, store.ResourceFilter{Kind: in.kind, ParentRID: &root.RID, OwnerPID: &sys.PID, Name: in.name, Limit: 20})
	if err != nil {
		return nil, err
	}
	if in.typed {
		named = ofOperatorType(named, in.name)
	}
	for i := range named {
		if named[i].Name == in.name || in.typed {
			return &named[i], nil
		}
	}
	return nil, nil
}

// unship removes what an earlier release shipped of a kind and this one does not, when nobody
// changed it since, and forgets it either way. It returns the URIs of what went, so that a
// default naming one falls back to what ships now.
func (s *Service) unship(ctx context.Context, kind string, ships map[string]bool) (map[string]bool, error) {
	gone := map[string]bool{}
	ledger, err := s.Store.ListShipped(ctx, kind)
	if err != nil {
		return nil, err
	}
	for _, led := range ledger {
		if ships[led.Name] {
			continue
		}
		if r, err := s.Store.GetResource(ctx, led.RID); err == nil && ShippedDigest(r.Spec, r.Description) == led.Digest {
			if err := s.Store.DeleteResource(ctx, r.RID); err != nil {
				return nil, fmt.Errorf("unship %s %s: %w", kind, led.Name, err)
			}
			gone[URI(r).String()] = true
			s.Log.Info("no longer shipped", "kind", kind, "name", led.Name, "rid", r.RID)
		}
		if err := s.Store.ForgetShipped(ctx, kind, led.Name); err != nil {
			return nil, err
		}
	}
	return gone, nil
}
