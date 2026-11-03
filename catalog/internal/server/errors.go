package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/engine"
	"github.com/apache/texera/catalog/internal/store"
)

// Problem is an error with an HTTP status and a stable code.
type Problem struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (p *Problem) Error() string { return p.Code + ": " + p.Message }

func badRequest(format string, args ...any) error {
	return &Problem{Status: http.StatusBadRequest, Code: "bad_request", Message: fmt.Sprintf(format, args...)}
}

func notFound(what string) error {
	return &Problem{Status: http.StatusNotFound, Code: "not_found", Message: what + " not found"}
}

func conflict(msg string) error {
	return &Problem{Status: http.StatusConflict, Code: "conflict", Message: msg}
}

func forbidden() error {
	return &Problem{Status: http.StatusForbidden, Code: "forbidden", Message: "the caller may not perform this action"}
}

func unavailable(what string, err error) error {
	return &Problem{Status: http.StatusBadGateway, Code: "unavailable", Message: what + ": " + err.Error()}
}

// toProblem normalizes any error into a Problem.
func toProblem(err error) *Problem {
	var p *Problem
	if errors.As(err, &p) {
		return p
	}
	switch {
	case errors.Is(err, store.ErrNotFound):
		return &Problem{Status: http.StatusNotFound, Code: "not_found", Message: "not found"}
	case errors.Is(err, store.ErrConflict):
		return &Problem{Status: http.StatusConflict, Code: "conflict", Message: "the resource changed; reload and retry"}
	case errors.Is(err, authz.ErrForbidden):
		return &Problem{Status: http.StatusForbidden, Code: "forbidden", Message: "the caller may not perform this action"}
	case errors.Is(err, authn.ErrUnauthenticated):
		return &Problem{Status: http.StatusUnauthorized, Code: "unauthenticated", Message: err.Error()}
	}
	var ue *engine.UnitError
	if errors.As(err, &ue) {
		return &Problem{Status: http.StatusBadGateway, Code: "unit_error", Message: ue.Error()}
	}
	return &Problem{Status: http.StatusInternalServerError, Code: "internal", Message: err.Error()}
}

// writeProblem writes a Problem as the contract's Error body.
func writeProblem(w http.ResponseWriter, p *Problem) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(p.Status)
	body := api.Error{Code: p.Code, Message: p.Message}
	if p.Details != nil {
		d := p.Details
		body.Details = &d
	}
	_ = json.NewEncoder(w).Encode(body)
}

// responseErrorHandler is the strict server's error hook.
func responseErrorHandler(log *slog.Logger) func(w http.ResponseWriter, r *http.Request, err error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		p := toProblem(err)
		if p.Status >= 500 {
			log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		}
		writeProblem(w, p)
	}
}

// requestErrorHandler handles binding errors (bad params, bad JSON).
func requestErrorHandler(w http.ResponseWriter, r *http.Request, err error) {
	writeProblem(w, &Problem{Status: http.StatusBadRequest, Code: "bad_request", Message: err.Error()})
}
