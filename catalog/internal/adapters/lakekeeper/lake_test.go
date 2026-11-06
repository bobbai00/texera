package lakekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/ports"
)

// tokens is the catalog's identity, for an adapter that only needs its own token.
type tokens struct{ ports.Identity }

func (tokens) ServiceToken(context.Context) (string, error) { return "catalog-token", nil }

// call is one request the adapter made.
type call struct {
	Method, Path string
	Body         map[string]any
}

// lakekeeper is Lakekeeper's management API as far as warehouses go: it lists what it was
// given, the way the real one writes a storage profile back, and records every call.
type lakekeeper struct {
	t          *testing.T
	warehouses []map[string]any
	answer     func(call) (int, string) // overrides the answer to a write; nil: accepted
	calls      []call
}

func (f *lakekeeper) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer catalog-token" {
		f.t.Errorf("%s %s without the catalog's token", r.Method, r.URL.Path)
	}
	c := call{Method: r.Method, Path: r.URL.Path}
	if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
		_ = json.Unmarshal(raw, &c.Body)
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodGet && r.URL.Path == "/management/v1/warehouse" {
		_ = json.NewEncoder(w).Encode(map[string]any{"warehouses": f.warehouses})
		return
	}
	f.calls = append(f.calls, c)
	if f.answer != nil {
		if status, body := f.answer(c); status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
			return
		}
	}
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(`{"warehouse-id":"new-id"}`))
}

func newLake(t *testing.T, f *lakekeeper) *Lake {
	t.Helper()
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return New(Options{URL: srv.URL, Tokens: tokens{}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

var store = ports.WarehouseStorage{Endpoint: "http://store:9000", Region: "us-east-1", Bucket: "texera", KeyPrefix: "warehouse", AccessKey: "key", SecretKey: "secret"}

// kept is a warehouse as Lakekeeper lists it: the endpoint ends with a slash, and the profile
// carries fields the catalog never set.
func kept(id, name string, s ports.WarehouseStorage) map[string]any {
	return map[string]any{"id": id, "name": name, "storage-profile": map[string]any{
		"type": "s3", "bucket": s.Bucket, "key-prefix": s.KeyPrefix, "endpoint": s.Endpoint + "/", "region": s.Region,
		"path-style-access": true, "sts-enabled": true, "flavor": "s3-compat", "sts-token-validity-seconds": 3600, "remote-signing-enabled": true,
	}}
}

func TestANewWarehouseIsCreatedWithItsPlaceAndItsKey(t *testing.T) {
	f := &lakekeeper{}
	lake := newLake(t, f)
	if err := lake.EnsureWarehouse(context.Background(), "w_1", store); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 1 || f.calls[0].Method != http.MethodPost || f.calls[0].Path != "/management/v1/warehouse" {
		t.Fatalf("the calls: %+v", f.calls)
	}
	body := f.calls[0].Body
	profile, _ := body["storage-profile"].(map[string]any)
	credential, _ := body["storage-credential"].(map[string]any)
	if body["warehouse-name"] != "w_1" || profile["bucket"] != "texera" || profile["key-prefix"] != "warehouse" || profile["endpoint"] != "http://store:9000" ||
		profile["sts-enabled"] != true || profile["flavor"] != "s3-compat" || credential["aws-access-key-id"] != "key" || credential["aws-secret-access-key"] != "secret" {
		t.Fatalf("the warehouse asked for: %v", body)
	}
}

func TestAWarehouseInTheSamePlaceOnlyHasItsKeyRefreshed(t *testing.T) {
	f := &lakekeeper{warehouses: []map[string]any{kept("id-1", "texera", store)}}
	lake := newLake(t, f)
	if err := lake.EnsureWarehouse(context.Background(), "texera", store); err != nil {
		t.Fatal(err)
	}
	// Lakekeeper wrote the endpoint back with a slash: it is still the same place.
	if len(f.calls) != 1 || f.calls[0].Path != "/management/v1/warehouse/id-1/storage-credential" {
		t.Fatalf("the calls: %+v", f.calls)
	}
	fresh, _ := f.calls[0].Body["new-storage-credential"].(map[string]any)
	if fresh["aws-secret-access-key"] != "secret" {
		t.Fatalf("the key handed over: %v", f.calls[0].Body)
	}

	// Another place: the storage is replaced, with its key.
	f.calls = nil
	moved := store
	moved.KeyPrefix = "elsewhere"
	if err := lake.EnsureWarehouse(context.Background(), "texera", moved); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 1 || f.calls[0].Path != "/management/v1/warehouse/id-1/storage" {
		t.Fatalf("the calls: %+v", f.calls)
	}
}

func TestAStorageTheLakeCannotUseIsRefusedWithItsReason(t *testing.T) {
	f := &lakekeeper{answer: func(call) (int, string) {
		return http.StatusBadRequest, `{"error":{"message":"Could not write to the bucket: access denied","type":"InvalidStorage","code":400}}`
	}}
	lake := newLake(t, f)
	err := lake.EnsureWarehouse(context.Background(), "w_1", store)
	if !errors.Is(err, ports.ErrStorageRefused) || !strings.Contains(err.Error(), "access denied") {
		t.Fatalf("want the lake's refusal with its reason, got %v", err)
	}
	// A lake that is failing is not a refusal: the caller did nothing wrong.
	f.answer = func(call) (int, string) { return http.StatusBadGateway, "upstream" }
	if err := lake.EnsureWarehouse(context.Background(), "w_1", store); err == nil || errors.Is(err, ports.ErrStorageRefused) {
		t.Fatalf("want a failure that is not a refusal, got %v", err)
	}
}

func TestAWarehouseIsRemovedOnceItIsEmpty(t *testing.T) {
	f := &lakekeeper{warehouses: []map[string]any{kept("id-1", "w_1", store)}}
	lake := newLake(t, f)
	lake.pause, lake.clearing = time.Millisecond, time.Second
	// It holds a namespace: refused at once, in the lake's words.
	f.answer = func(call) (int, string) {
		return http.StatusConflict, `{"error":{"message":"Warehouse is not empty. Cannot delete a non-empty warehouse.","type":"WarehouseNotEmpty","code":409}}`
	}
	if err := lake.RemoveWarehouse(context.Background(), "w_1"); !errors.Is(err, ports.ErrWarehouseNotEmpty) || !strings.Contains(err.Error(), "Cannot delete a non-empty warehouse") || len(f.calls) != 1 {
		t.Fatalf("want not empty at once, got %v after %d calls", err, len(f.calls))
	}
	// Its last namespace was just dropped: the lake is clearing the files, and is waited for.
	f.calls = nil
	f.answer = func(call) (int, string) {
		if len(f.calls) < 3 {
			return http.StatusConflict, `{"error":{"message":"Warehouse has unfinished tasks. Cannot delete warehouse until all tasks are finished.","type":"WarehouseHasUnfinishedTasks","code":409}}`
		}
		return 0, ""
	}
	if err := lake.RemoveWarehouse(context.Background(), "w_1"); err != nil {
		t.Fatal(err)
	}
	if last := f.calls[len(f.calls)-1]; len(f.calls) != 3 || last.Method != http.MethodDelete || last.Path != "/management/v1/warehouse/id-1" {
		t.Fatalf("the calls: %+v", f.calls)
	}
	// A lake that never finishes is not waited for longer than it should take.
	lake.clearing = 20 * time.Millisecond
	f.answer = func(call) (int, string) {
		return http.StatusConflict, `{"error":{"message":"Warehouse has unfinished tasks.","type":"WarehouseHasUnfinishedTasks","code":409}}`
	}
	if err := lake.RemoveWarehouse(context.Background(), "w_1"); !errors.Is(err, ports.ErrWarehouseNotEmpty) || !strings.Contains(err.Error(), "unfinished tasks") {
		t.Fatalf("want not empty with the lake's reason, got %v", err)
	}
	// One the lake never had is gone already.
	f.answer = nil
	if err := lake.RemoveWarehouse(context.Background(), "w_unknown"); err != nil {
		t.Fatal(err)
	}
}
