package catalog

import (
	"context"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// Live sessions: several people editing one resource at once, through the platform's live
// service. The catalog stays the authority: it decides who may join (the same permissions as
// every other call), its versions are what a session saves into, and it keeps the session's
// working copy beside the resource so the same document continues next time. The working
// copy is the live service's alone; everyone else reads and writes versions.

// LiveState returns the live document of a resource, for the live service.
func (s *Service) LiveState(ctx context.Context, caller *auth.Caller, rid uuid.UUID) (*store.LiveState, error) {
	if !caller.Service {
		return nil, Forbidden()
	}
	l, err := s.Store.GetLiveState(ctx, rid)
	return l, wrap(err, "live document")
}

// KeepLiveState keeps the live document of a resource, for the live service.
func (s *Service) KeepLiveState(ctx context.Context, caller *auth.Caller, rid uuid.UUID, basedOn *int, state []byte) error {
	if !caller.Service {
		return Forbidden()
	}
	if _, err := s.Store.GetResource(ctx, rid); err != nil {
		return wrap(err, "resource")
	}
	return wrap(s.Store.PutLiveState(ctx, rid, basedOn, state), "live document")
}

// authorsOf settles who a new version is by. It is the caller's, unless the live service
// saves what several people edited together: then the first of them is its creator and, when
// there is more than one, all of them are its contributors. Only the live service, which held
// their edits, may write in their names.
func (s *Service) authorsOf(ctx context.Context, caller *auth.Caller, onBehalfOf []uuid.UUID) (creator uuid.UUID, contributors []uuid.UUID, err error) {
	if len(onBehalfOf) == 0 {
		return caller.PID(), nil, nil
	}
	if !caller.Service {
		return uuid.Nil, nil, Forbidden()
	}
	for _, pid := range onBehalfOf {
		if _, err := s.Store.GetPrincipal(ctx, pid); err != nil {
			return uuid.Nil, nil, NotFound("principal " + pid.String())
		}
	}
	if len(onBehalfOf) > 1 {
		contributors = onBehalfOf
	}
	return onBehalfOf[0], contributors, nil
}
