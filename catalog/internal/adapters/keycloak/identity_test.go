package keycloak

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// A service token Keycloak stopped honoring (it restarted while the catalog kept the token) is
// dropped on the 401 and the admin request goes again with a new one, for the admin calls of
// the units' identities and for the search for people alike.
func TestAnAdminCallAfterKeycloakRestartedGetsANewToken(t *testing.T) {
	var issued, admin atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/auth/realms/texera/protocol/openid-connect/token":
			n := issued.Add(1)
			fmt.Fprintf(w, `{"access_token": "t%d", "expires_in": 3600}`, n)
		case "/auth/admin/realms/texera/clients", "/auth/admin/realms/texera/users":
			admin.Add(1)
			// Every token from before the restart is refused.
			if r.Header.Get("Authorization") == "Bearer t1" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Fprint(w, `[]`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	id := &Identity{opts: Options{ServiceClientID: "texera-services", ServiceClientSecret: "s"}, tokenURL: srv.URL + "/auth/realms/texera/protocol/openid-connect/token"}

	var clients []any
	if err := id.adminJSON(context.Background(), "clients?clientId=unit-x", &clients); err != nil {
		t.Fatalf("after the restart: %v", err)
	}
	if issued.Load() != 2 || admin.Load() != 2 {
		t.Fatalf("tokens issued %d, admin calls %d", issued.Load(), admin.Load())
	}
	// The new token is kept: the next call needs no other.
	if _, err := id.SearchUsers(context.Background(), "bob", 5); err != nil || issued.Load() != 2 {
		t.Fatalf("a search after it: %v, tokens issued %d", err, issued.Load())
	}
}
