package catalog

// What a chat made, and what it worked from, as the catalog records them. A resource or a
// version made in one of the chat's turns carries the chat as its origin. What the chat worked
// from is what a person attached to a message, and what the chat's work names at a version:
// what its executions ran and read, what the versions and the other resources it made
// reference. What a tool merely returned, a search hit or a listed unit, is neither.

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/kinds"
	"github.com/apache/texera/catalog/internal/store"
	"github.com/apache/texera/catalog/internal/uri"
)

// ChatResource is a resource as a chat knows it, with the versions that count.
type ChatResource struct {
	Resource store.Resource
	// Made is true when the chat made the resource or a version of it.
	Made bool
	// Versions are those the chat made and those it worked from, newest first.
	Versions []ChatVersion
}

// ChatVersion is a version the chat made, or one it worked from.
type ChatVersion struct {
	store.Version
	Made bool
}

// chatLimit bounds how many of the resources a chat made it lists; listLimit is the most a
// store list returns at once.
const (
	chatLimit = 200
	listLimit = 500
)

// ConversationResources lists what a chat made or changed, the latest first, then what it
// worked from, by name: each resource the caller may read once. What the chat worked from is
// the chat's whoever asks; who asks decides only what of it they see.
func (s *Service) ConversationResources(ctx context.Context, caller *auth.Caller, rid uuid.UUID) ([]ChatResource, error) {
	if _, err := s.Get(ctx, caller, &conversationKind, rid); err != nil {
		return nil, err
	}
	made, err := s.Store.ListResources(ctx, store.ResourceFilter{OriginConversation: &rid, Limit: chatLimit})
	if err != nil {
		return nil, err
	}
	versions, err := s.Store.VersionsMadeIn(ctx, rid)
	if err != nil {
		return nil, err
	}
	used, err := s.workedFrom(ctx, rid, made, versions)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(made)+len(used))
	for _, r := range made {
		ids = append(ids, r.RID)
	}
	var keys []store.VersionKey
	for _, ref := range used {
		id, err := uuid.Parse(ref.Rid)
		if err != nil {
			continue
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
		if key := (store.VersionKey{RID: id, Vno: ref.Vno}); ref.Vno > 0 && !slices.Contains(keys, key) {
			keys = append(keys, key)
		}
	}
	seen, err := s.Store.ListResources(ctx, store.ResourceFilter{RIDs: ids, ReadableBy: readableBy(caller), Limit: min(len(ids), listLimit)})
	if err != nil {
		return nil, err
	}
	visible := make(map[uuid.UUID]bool, len(seen))
	for _, r := range seen {
		visible[r.RID] = true
	}

	var list chatList
	for _, r := range made {
		if visible[r.RID] {
			list.add(r, true)
		}
	}
	for _, v := range versions {
		list.version(v, true)
	}
	slices.SortStableFunc(list.items, func(a, b *ChatResource) int { return madeAt(b, rid).Compare(madeAt(a, rid)) })
	slices.SortStableFunc(seen, func(a, b store.Resource) int {
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	for _, r := range seen {
		list.add(r, false)
	}
	worked, err := s.Store.VersionSummaries(ctx, slices.DeleteFunc(keys, func(k store.VersionKey) bool { return !list.lacks(k) }))
	if err != nil {
		return nil, err
	}
	for _, v := range worked {
		list.version(v, false)
	}

	out := make([]ChatResource, 0, len(list.items))
	for _, item := range list.items {
		slices.SortFunc(item.Versions, func(a, b ChatVersion) int { return b.Vno - a.Vno })
		out = append(out, *item)
	}
	return out, nil
}

// workedFrom names what a chat worked from: what a person attached to a message, at the
// version attached when there is one, then what the chat's executions ran and read, and what
// the versions and the other resources it made name at a version. A name without a version is
// a live link, the unit a workflow runs on or a credential, not something worked from.
func (s *Service) workedFrom(ctx context.Context, chat uuid.UUID, made []store.Resource, versions []store.Version) ([]uri.Ref, error) {
	attached, err := s.Store.Attached(ctx, chat)
	if err != nil {
		return nil, err
	}
	var refs []uri.Ref
	for _, name := range attached {
		if ref, err := uri.Parse(name); err == nil && !ref.Kind.Singleton {
			refs = append(refs, ref)
		}
	}
	var named, sources []string
	byRID := make(map[uuid.UUID]*store.Resource, len(made))
	for i := range made {
		r := &made[i]
		byRID[r.RID] = r
		if r.Kind == "execution" {
			var spec api.ExecutionSpec
			if json.Unmarshal(r.Spec, &spec) == nil {
				named = append(named, string(spec.Workflow))
				if spec.Inputs != nil {
					for _, in := range *spec.Inputs {
						named = append(named, string(in))
					}
				}
			}
		} else if k, _ := kinds.ByName(r.Kind); !k.Versioned {
			sources = append(sources, URI(r).String())
		}
	}
	for _, v := range versions {
		if r := byRID[v.RID]; r != nil {
			sources = append(sources, URI(r).WithVersion(v.Vno).String())
		}
	}
	edges, err := s.Store.ReferencesFrom(ctx, sources)
	if err != nil {
		return nil, err
	}
	for _, e := range edges {
		named = append(named, e.To)
	}
	for _, name := range named {
		if ref, err := uri.Parse(name); err == nil && ref.Vno > 0 {
			refs = append(refs, ref)
		}
	}
	return refs, nil
}

// madeAt is when the chat last made something of a resource: the resource, or a version of it.
func madeAt(item *ChatResource, chat uuid.UUID) time.Time {
	var at time.Time
	if o := item.Resource.Origin; o != nil && o.Conversation == chat {
		at = item.Resource.CreatedAt
	}
	for _, v := range item.Versions {
		if v.Made && v.CreatedAt.After(at) {
			at = v.CreatedAt
		}
	}
	return at
}

// chatList gathers a chat's resources, each once, with their versions.
type chatList struct {
	items []*ChatResource
	byRID map[uuid.UUID]*ChatResource
}

func (l *chatList) add(r store.Resource, made bool) {
	if l.byRID == nil {
		l.byRID = map[uuid.UUID]*ChatResource{}
	}
	if l.byRID[r.RID] != nil {
		return
	}
	item := &ChatResource{Resource: r, Made: made}
	l.items = append(l.items, item)
	l.byRID[r.RID] = item
}

// version adds a version to its resource when the list has the resource; a version the chat
// made stays made when it also worked from it.
func (l *chatList) version(v store.Version, made bool) {
	item := l.byRID[v.RID]
	if item == nil {
		return
	}
	for i := range item.Versions {
		if item.Versions[i].Vno == v.Vno {
			item.Versions[i].Made = item.Versions[i].Made || made
			return
		}
	}
	item.Versions = append(item.Versions, ChatVersion{Version: v, Made: made})
}

// lacks reports whether the list has the resource of a version but not the version.
func (l *chatList) lacks(k store.VersionKey) bool {
	item := l.byRID[k.RID]
	return item != nil && !slices.ContainsFunc(item.Versions, func(v ChatVersion) bool { return v.Vno == k.Vno })
}
