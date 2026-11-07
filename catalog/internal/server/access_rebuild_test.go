package server_test

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"github.com/apache/texera/catalog/internal/adapters/memory"
	"github.com/apache/texera/catalog/internal/authz"
)

// The authorizer is a copy of what the catalog's own tables say about who may do what. A
// rebuild into an authorizer that knows nothing gives it all of that again: the owners, what
// lives in what, the grants, what is public, the projects that inherit from others, and Texera
// being everyone's to use.
func TestARebuildGivesAnEmptyAuthorizerEverythingTheCatalogHolds(t *testing.T) {
	h := newHarness(t)
	alice, bob := principalOf(h, "alice"), principalOf(h, "bob")
	empty := map[string]any{"operators": []any{}, "links": []any{}}
	lab := h.create("alice", "projects", "lab", map[string]any{})
	inLab := createIn(h, "alice", "workflows", "in the lab", lab.Metadata.Rid, empty)
	shared := h.create("alice", "workflows", "shared with bob", empty)
	open := h.create("alice", "workflows", "open to all", empty)
	taken := h.create("alice", "workflows", "taken back", empty)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(shared)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)
	h.mustJSON("alice", "PATCH", p+"/resources/"+rid(open), map[string]any{"visibility": "public"}, nil)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(taken)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	h.mustJSON("alice", "DELETE", p+"/resources/"+rid(taken)+"/grants/"+bob, nil, nil)
	// Alice's study inherits from her lab, and bob is a member of the study.
	var study envelope
	h.mustJSON("alice", "POST", p+"/projects", map[string]any{"name": "study", "base": lab.Metadata.Rid, "spec": map[string]any{}}, &study)
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(study)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)

	fresh := memory.NewAuthorizer()
	relay := authz.NewRelay(outbox{h.svc.Store}, fresh, slog.New(slog.NewTextHandler(io.Discard, nil)))
	n, err := relay.Rebuild(context.Background())
	if err != nil || n == 0 {
		t.Fatalf("rebuild: %d tuples, %v", n, err)
	}
	may := func(pid, permission, r string) bool {
		t.Helper()
		ok, err := fresh.Check(context.Background(), "user:"+pid, "can_"+permission, "resource:"+r)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	for name, ok := range map[string]bool{
		"alice owns her lab":                        may(alice, "delete", rid(lab)),
		"and what is in it, through the lab":        may(alice, "write", rid(inLab)),
		"bob edits what was shared with him":        may(bob, "write", rid(shared)),
		"everyone reads what is public":             may(bob, "read", rid(open)),
		"everyone uses what Texera holds":           may(bob, "use", h.svc.Root().RID.String()),
		"bob reads what the study inherits":         may(bob, "read", rid(inLab)),
		"and does not change it":                    !may(bob, "write", rid(inLab)),
		"bob does not administer the lab":           !may(bob, "admin", rid(lab)),
		"nor what was shared and taken back":        !may(bob, "read", rid(taken)),
		"and does not write what is only public":    !may(bob, "write", rid(open)),
		"bob owns his home, as before the rebuild":  may(bob, "delete", string(me(h, "bob").HomeProject)),
		"alice does not get into it by the rebuild": !may(alice, "read", string(me(h, "bob").HomeProject)),
	} {
		if !ok {
			t.Errorf("after the rebuild: %s: not so", name)
		}
	}
}
