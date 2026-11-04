// Package engine talks to computing units through the generated client of the unit API
// (api/engine.tsp). A Unit is one endpoint; the catalog keeps no engine state.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
	return fmt.Sprintf("unit answered %d: %s", e.Status, truncate(e.Body, 300))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func check(status int, body []byte) error {
	if status >= 200 && status < 300 {
		return nil
	}
	return &UnitError{Status: status, Body: string(body)}
}

// Health probes the unit.
func (u *Unit) Health(ctx context.Context) (*UnitHealth, error) {
	resp, err := u.client.HealthCheckWithResponse(ctx)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Operators lists the unit's operator types.
func (u *Unit) Operators(ctx context.Context) (*OperatorTypeList, error) {
	resp, err := u.client.OperatorsListWithResponse(ctx)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Compile compiles a logical plan on the unit.
func (u *Unit) Compile(ctx context.Context, logicalPlan any) (*CompileResult, error) {
	resp, err := u.client.CompileCompileWithResponse(ctx, EngineCompileRequest{LogicalPlan: logicalPlan})
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Start submits an execution.
func (u *Unit) Start(ctx context.Context, req ExecutionStartRequest) (*ExecutionAck, error) {
	resp, err := u.client.ExecutionsStartWithResponse(ctx, req)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Status reads an execution's state on the unit.
func (u *Unit) Status(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsStatusWithResponse(ctx, eid)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Cancel stops an execution.
func (u *Unit) Cancel(ctx context.Context, eid string) (*ExecutionState, error) {
	resp, err := u.client.ExecutionsCancelWithResponse(ctx, eid)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// Result reads a page of a port result. Cells keep their exact numbers (json.Number), so a long
// column passes through without the float64 rounding a plain decode would apply. table is where
// the result was recorded (empty when unknown): a unit that no longer holds the run reads it there.
func (u *Unit) Result(ctx context.Context, eid, opid, port, table string, offset int64, limit int32) (*RowPage, error) {
	params := &ExecutionsResultParams{Offset: &offset, Limit: &limit}
	if table != "" {
		params.Table = &table
	}
	resp, err := u.client.ExecutionsResultWithResponse(ctx, eid, opid, port, params)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	var page RowPage
	dec := json.NewDecoder(bytes.NewReader(resp.Body))
	dec.UseNumber()
	if err := dec.Decode(&page); err != nil {
		return nil, fmt.Errorf("unit result page: %w", err)
	}
	return &page, nil
}

// BuildEnvironment asks the unit to build an environment version.
func (u *Unit) BuildEnvironment(ctx context.Context, req EnvironmentRequest) (*EnvironmentBuild, error) {
	resp, err := u.client.EnvironmentsBuildWithResponse(ctx, req)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// EnvironmentStatus reads the state of an environment build on the unit.
func (u *Unit) EnvironmentStatus(ctx context.Context, rid string, vno int32) (*EnvironmentBuild, error) {
	resp, err := u.client.EnvironmentsStatusWithResponse(ctx, rid, vno)
	if err != nil {
		return nil, err
	}
	if err := check(resp.StatusCode(), resp.Body); err != nil {
		return nil, err
	}
	return resp.JSON200, nil
}

// MustJSON renders a value as JSON for logs; never fails.
func MustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}
