package authz

import (
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/authn"
)

// ExtAuthzHandler answers the gateway's ext_authz checks. Envoy forwards the original
// path under the configured prefix and the original headers; 200 allows, 401 and 403 deny.
// Fine-grained decisions stay in the catalog; this is the coarse gate: every protected
// route needs a valid token, unit routes need read access to the unit.
func ExtAuthzHandler(verifier *authn.Verifier, pdp *PDP, prefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		original := strings.TrimPrefix(r.URL.Path, prefix)
		if original == "" {
			original = "/"
		}
		caller, err := verifier.Resolve(r.Context(), r)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="texera"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.HasPrefix(original, "/units/") {
			parts := strings.SplitN(strings.TrimPrefix(original, "/units/"), "/", 2)
			rid, err := uuid.Parse(parts[0])
			if err != nil {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			if err := pdp.Require(r.Context(), caller, ActionRead, rid); err != nil {
				w.WriteHeader(http.StatusForbidden)
				return
			}
		}
		if strings.HasPrefix(original, "/lineage/") && !caller.IsService {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("X-Texera-Principal", caller.Principal.PID.String())
		w.WriteHeader(http.StatusOK)
	})
}
