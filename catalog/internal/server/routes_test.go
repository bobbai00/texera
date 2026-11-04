package server_test

import (
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/store"
)

type storeResource = store.Resource

func mustUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		panic(err)
	}
	return id
}

var placeholder = regexp.MustCompile(`\{([a-zA-Z]+)\}`)

// TestEveryOperationIsRouted walks the generated permission table: every method and path of
// the contract must be served by a handler, so the OpenAPI document and the server cannot
// drift apart silently.
func TestEveryOperationIsRouted(t *testing.T) {
	h := newHarness(t)
	for key := range authz.Permissions {
		method, path, _ := strings.Cut(key, " ")
		concrete := placeholder.ReplaceAllStringFunc(path, func(m string) string {
			switch m {
			case "{vno}", "{seq}":
				return "1"
			case "{path}":
				return "dir/file.csv"
			case "{operatorID}", "{portID}", "{name}":
				return "x"
			case "{turn}":
				return uuid.NewString()
			default:
				return uuid.NewString()
			}
		})
		req, err := http.NewRequest(method, concrete, nil)
		if err != nil {
			t.Fatal(err)
		}
		if pattern := h.srv.Match(req); pattern == "" {
			t.Errorf("%s %s: no handler", method, path)
		}
	}
	// And every permission value is one the decision point knows.
	known := map[string]bool{"list": true, "create": true, "read": true, "write": true, "share": true, "delete": true, "execute": true, "use": true, "run_on": true, "rotate": true, "self": true, "service": true, "admin": true, "public": true}
	for key, perm := range authz.Permissions {
		if !known[perm] {
			t.Errorf("%s: unknown permission %q", key, perm)
		}
	}
}
