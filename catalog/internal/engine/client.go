// Package engine talks to computing units through the generated client of the unit API
// (api/engine.tsp). A Unit is one endpoint; the catalog keeps no engine state.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Unit is a client for one computing unit.
type Unit struct {
	Endpoint string
	client   *ClientWithResponses
}

// NewUnit builds a client for the unit at endpoint; token, when non-empty, is sent as a
// bearer on every call.
func NewUnit(endpoint string, token string) (*Unit, error) {
	hc := &http.Client{Timeout: 10 * time.Minute}
	opts := []ClientOption{WithHTTPClient(hc)}
	if token != "" {
		opts = append(opts, WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
			req.Header.Set("Authorization", "Bearer "+token)
			return nil
		}))
	}
	c, err := NewClientWithResponses(endpoint, opts...)
	if err != nil {
		return nil, err
	}
	return &Unit{Endpoint: endpoint, client: c}, nil
}

// UnitError is a non-2xx answer from the unit.
type UnitError struct {
	Status int
	Body   string
}

func (e *UnitError) Error() string {
	return fmt.Sprintf("unit answered %d: %s", e.Status, e.Message())
}

// Message is what the engine said: the message of a JSON error, whatever else the body holds; a
// body that is not one of ours (a proxy's page, say), bounded; or the status when there is neither.
func (e *UnitError) Message() string {
	var body struct {
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(e.Body), &body) == nil && body.Message != "" {
		return body.Message
	}
	if text := strings.TrimSpace(e.Body); text != "" {
		return truncate(text, 300)
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// answer reads one raw answer of the generated client: the body of a 2xx, or a *UnitError. The
// generated WithResponse parsers decode an error body into the contract's Error and fail when its
// shape differs, which loses the status and the engine's words; a unit of another version, or a
// proxy in front of one, must still be able to say what went wrong.
func answer(resp *http.Response, err error) ([]byte, error) {
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &UnitError{Status: resp.StatusCode, Body: string(body)}
	}
	return body, nil
}

// decode reads an answer into its type.
func decode[T any](resp *http.Response, err error) (*T, error) {
	body, err := answer(resp, err)
	if err != nil {
		return nil, err
	}
	var out T
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("unit answer: %w", err)
	}
	return &out, nil
}

// Health probes the unit.
func (u *Unit) Health(ctx context.Context) (*UnitHealth, error) {
	resp, err := u.client.HealthCheck(ctx)
	return decode[UnitHealth](resp, err)
}

// Operators lists the unit's operator types.
func (u *Unit) Operators(ctx context.Context) (*OperatorTypeList, error) {
	resp, err := u.client.OperatorsList(ctx)
	return decode[OperatorTypeList](resp, err)
}

// Compile compiles a logical plan on the unit.
func (u *Unit) Compile(ctx context.Context, logicalPlan any) (*CompileResult, error) {
	resp, err := u.client.CompileCompile(ctx, EngineCompileRequest{LogicalPlan: logicalPlan})
	return decode[CompileResult](resp, err)
}

// Start submits an execution.
func (u *Unit) Start(ctx context.Context, req ExecutionStartRequest) (*ExecutionAck, error) {
	resp, err := u.client.ExecutionsStart(ctx, req)
	return decode[ExecutionAck](resp, err)
}

// Status reads an execution's state on the unit.
func (u *Unit) Status(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsStatus(ctx, eid)
	return decode[ExecutionState](resp, err)
}

// Cancel stops an execution.
func (u *Unit) Cancel(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsCancel(ctx, eid)
	return decode[ExecutionState](resp, err)
}

// Pause asks the unit to pause a run; the state follows when the engine confirms.
func (u *Unit) Pause(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsPause(ctx, eid)
	return decode[ExecutionState](resp, err)
}

// Resume continues a paused run.
func (u *Unit) Resume(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsResume(ctx, eid)
	return decode[ExecutionState](resp, err)
}

// Result reads a page of a port result. Cells keep their exact numbers (json.Number), so a long
// column passes through without the float64 rounding a plain decode would apply. table is where
// the result was recorded (empty when unknown) and namespace the execution's namespace: a unit
// that no longer holds the run reads it there.
func (u *Unit) Result(ctx context.Context, eid, opid, port, table, namespace string, offset int64, limit int32) (*RowPage, error) {
	params := &ExecutionsResultParams{Offset: &offset, Limit: &limit}
	if table != "" {
		params.Table = &table
	}
	if namespace != "" {
		params.Namespace = &namespace
	}
	resp, err := u.client.ExecutionsResult(ctx, eid, opid, port, params)
	body, err := answer(resp, err)
	if err != nil {
		return nil, err
	}
	var page RowPage
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&page); err != nil {
		return nil, fmt.Errorf("unit result page: %w", err)
	}
	return &page, nil
}

// BuildEnvironment asks the unit to build an environment version.
func (u *Unit) BuildEnvironment(ctx context.Context, req EnvironmentRequest) (*EnvironmentBuild, error) {
	resp, err := u.client.EnvironmentsBuild(ctx, req)
	return decode[EnvironmentBuild](resp, err)
}

// EnvironmentStatus reads the state of an environment build on the unit.
func (u *Unit) EnvironmentStatus(ctx context.Context, rid string, vno int32) (*EnvironmentBuild, error) {
	resp, err := u.client.EnvironmentsStatus(ctx, rid, vno)
	return decode[EnvironmentBuild](resp, err)
}

// MustJSON renders a value as JSON for logs; never fails.
func MustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}
