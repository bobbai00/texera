package catalog

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/apache/texera/catalog/internal/engine"
)

func TestUnitFailed(t *testing.T) {
	refusal := func(status int, message string) error {
		return &engine.UnitError{Status: status, Body: fmt.Sprintf(`{"code":%d,"message":%q}`, status, message)}
	}
	cases := []struct {
		name   string
		err    error
		status int
		code   string
		words  string
	}{
		{"a bad request", refusal(400, "environment build failed"), http.StatusBadRequest, "invalid", "environment build failed"},
		{"an unprocessable request", refusal(422, "no such column"), http.StatusBadRequest, "invalid", "no such column"},
		{"not found", refusal(404, "no table e_1.t"), http.StatusNotFound, "not_found", "no table e_1.t"},
		{"a conflict", refusal(409, "already started"), http.StatusConflict, "conflict", "already started"},
		{"the engine failed", refusal(500, "the table is corrupt"), http.StatusBadGateway, "unit_error", "unit: the table is corrupt"},
		{"the catalog's own token refused", refusal(401, "bad token"), http.StatusBadGateway, "unit_error", "unit: bad token"},
		{"wrapped", fmt.Errorf("reading: %w", refusal(404, "gone")), http.StatusNotFound, "not_found", "gone"},
		{"no answer at all", errors.New("connection refused"), http.StatusBadGateway, "unavailable", "unit: connection refused"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := UnitFailed(tc.err)
			if got.Status != tc.status || got.Code != tc.code || !strings.Contains(got.Message, tc.words) {
				t.Fatalf("got %d %s %q; want %d %s %q", got.Status, got.Code, got.Message, tc.status, tc.code, tc.words)
			}
		})
	}
}
