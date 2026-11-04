package server_test

import (
	"net/http"
	"testing"

	"github.com/apache/texera/catalog/internal/server"
)

// A person the identity provider knows but who has never logged in can be found and granted
// access; their first login then takes over the principal.
func TestPrincipalsFromTheDirectory(t *testing.T) {
	h := newHarness(t)
	var page struct {
		Items []struct {
			Pid         string `json:"pid"`
			DisplayName string `json:"displayName"`
			Email       string `json:"email"`
		} `json:"items"`
	}
	h.mustJSON("alice", "GET", server.Prefix+"/principals?q=carol", nil, &page)
	if len(page.Items) != 1 || page.Items[0].DisplayName != "Carol Lovelace" || page.Items[0].Email != "carol@example.org" {
		t.Fatalf("carol from the directory: %+v", page.Items)
	}
	carol := page.Items[0].Pid
	h.mustJSON("alice", "GET", server.Prefix+"/principals?q=carol", nil, &page)
	if len(page.Items) != 1 || page.Items[0].Pid != carol {
		t.Fatalf("a second search finds the same principal: %+v", page.Items)
	}

	var wf map[string]any
	h.mustJSON("alice", "POST", server.Prefix+"/workflows", map[string]any{"name": "for carol", "spec": map[string]any{"operators": []any{}, "links": []any{}}}, &wf)
	rid := wf["metadata"].(map[string]any)["rid"].(string)
	if status, _ := h.do("carol", "GET", server.Prefix+"/workflows/"+rid, nil); status != http.StatusForbidden && status != http.StatusNotFound {
		t.Fatalf("before the grant carol gets %d", status)
	}
	h.mustJSON("alice", "PUT", server.Prefix+"/resources/"+rid+"/grants/"+carol, map[string]any{"relation": "viewer"}, nil)
	if status, _ := h.do("carol", "GET", server.Prefix+"/workflows/"+rid, nil); status != http.StatusOK {
		t.Fatalf("after the grant carol gets %d", status)
	}
	var me struct {
		Principal struct {
			Pid string `json:"pid"`
		} `json:"principal"`
	}
	h.mustJSON("carol", "GET", server.Prefix+"/me", nil, &me)
	if me.Principal.Pid != carol {
		t.Fatalf("carol's login took over the imported principal: %s vs %s", me.Principal.Pid, carol)
	}
}
