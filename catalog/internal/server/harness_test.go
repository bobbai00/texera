package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"

	"github.com/apache/texera/catalog/internal/adapters/memory"
	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/catalog"
	"github.com/apache/texera/catalog/internal/ports"
	"github.com/apache/texera/catalog/internal/server"
	"github.com/apache/texera/catalog/internal/store"
)

// fakeIdentity accepts tokens that name a user: "alice", "bob", "admin" (an administrator),
// "service" (the platform's service client), "unit" (the seeded unit's client, texera-unit)
// and "unit:<clientId>" (any unit client; the subject is what memory.Workloads gives it).
type fakeIdentity struct{}

func (fakeIdentity) Verify(_ context.Context, token string) (ports.Claims, error) {
	switch token {
	case "":
		return ports.Claims{}, ports.ErrUnauthenticated
	case "service":
		return ports.Claims{Subject: "service:texera-services", Name: "texera-services", ClientID: "texera-services", Service: true}, nil
	case "admin":
		return ports.Claims{Subject: "sub:admin", Name: "admin", ClientID: "texera-app", Roles: []string{"admin"}}, nil
	case "unit":
		return ports.Claims{Subject: "sa:texera-unit", ClientID: "texera-unit"}, nil
	}
	if client, ok := strings.CutPrefix(token, "unit:"); ok {
		return ports.Claims{Subject: "sa:" + client, ClientID: client}, nil
	}
	if strings.HasPrefix(token, "bad") {
		return ports.Claims{}, ports.ErrUnauthenticated
	}
	return ports.Claims{Subject: "sub:" + token, Name: token, Email: token + "@example.org", ClientID: "texera-app"}, nil
}

// isUnitClient tells the clients units run as, as main.go does.
func isUnitClient(clientID string) bool {
	return clientID == "texera-unit" || strings.HasPrefix(clientID, "unit-")
}

func (fakeIdentity) ServiceToken(context.Context) (string, error) { return "service", nil }

// SearchUsers knows one person who has never logged in: carol.
func (fakeIdentity) SearchUsers(_ context.Context, q string, _ int) ([]ports.User, error) {
	if strings.Contains(strings.ToLower(q), "car") {
		return []ports.User{{Subject: "sub:carol", DisplayName: "Carol Lovelace", Email: "carol@example.org"}}, nil
	}
	return nil, nil
}

// fakeUnit is an engine: health, operators, compile, start, status, results, environments.
type fakeUnit struct {
	*httptest.Server
	mu              sync.Mutex
	started         []map[string]any
	controlled      []string
	compiled        int
	resultNamespace string
	// refuse, when set, answers before the engine does: a request it returns true for is done.
	refuse func(w http.ResponseWriter, r *http.Request) bool
}

// refusing makes the unit answer like Dropwizard's own error mappers: a numeric code and a message.
func (u *fakeUnit) refusing(suffix string, status int, message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.refuse = func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.HasSuffix(r.URL.Path, suffix) {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": status, "message": message})
		return true
	}
}

func newFakeUnit(t *testing.T) *fakeUnit {
	t.Helper()
	u := &fakeUnit{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"status": "ok", "version": "engine-test-1"})
	})
	mux.HandleFunc("GET /api/operators", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"groups": []any{}, "operators": []any{
			map[string]any{"operatorType": "CSVFileScan", "userFriendlyName": "CSV File Scan", "operatorGroupName": "Source", "operatorDescription": "Reads a CSV file",
				"jsonSchema": map[string]any{"type": "object", "properties": map[string]any{"fileName": map[string]any{"type": "string"}}}, "inputPorts": []any{}, "outputPorts": []any{map[string]any{"portID": "output-0"}}},
			map[string]any{"operatorType": "Aggregate", "userFriendlyName": "Aggregate", "operatorGroupName": "Analysis", "operatorDescription": "Aggregates",
				"jsonSchema": map[string]any{"type": "object"}, "inputPorts": []any{map[string]any{"portID": "input-0"}}, "outputPorts": []any{map[string]any{"portID": "output-0"}}},
		}})
	})
	mux.HandleFunc("POST /api/compile", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.compiled++
		u.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "operatorOutputSchemas": map[string]any{"scan": map[string]any{"output-0": []any{map[string]any{"attributeName": "a", "attributeType": "integer"}}}}, "operatorErrors": map[string]any{}})
	})
	mux.HandleFunc("POST /api/executions", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		u.mu.Lock()
		u.started = append(u.started, req)
		u.mu.Unlock()
		writeJSON(w, map[string]any{"eid": req["eid"], "accepted": true})
	})
	mux.HandleFunc("GET /api/executions/{eid}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"eid": r.PathValue("eid"), "status": "running", "operators": map[string]any{}, "results": []any{}})
	})
	mux.HandleFunc("POST /api/executions/{eid}/cancel", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"eid": r.PathValue("eid"), "status": "cancelled", "operators": map[string]any{}, "results": []any{}})
	})
	// Pause and resume are acknowledged; the state follows through lineage events, as on a real unit.
	for _, verb := range []string{"pause", "resume"} {
		mux.HandleFunc("POST /api/executions/{eid}/"+verb, func(w http.ResponseWriter, r *http.Request) {
			u.mu.Lock()
			u.controlled = append(u.controlled, verb+" "+r.PathValue("eid"))
			u.mu.Unlock()
			writeJSON(w, map[string]any{"eid": r.PathValue("eid"), "status": "running", "operators": map[string]any{}, "results": []any{}})
		})
	}
	mux.HandleFunc("GET /api/executions/{eid}/results/{opid}/{port}", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.resultNamespace = r.URL.Query().Get("namespace")
		u.mu.Unlock()
		offset := 0
		fmt.Sscanf(r.URL.Query().Get("offset"), "%d", &offset)
		rows := [][]any{{"setosa", 1.46}, {"versicolor", 4.26}, {"virginica", 5.55}}
		if offset >= len(rows) {
			rows = nil
		} else {
			rows = rows[offset:]
		}
		writeJSON(w, map[string]any{"schema": []any{map[string]any{"attributeName": "Species", "attributeType": "string"}, map[string]any{"attributeName": "avg", "attributeType": "double"}}, "rows": rows, "offset": offset, "total": 3})
	})
	mux.HandleFunc("POST /api/environments", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		writeJSON(w, map[string]any{"rid": req["rid"], "vno": req["vno"], "status": "ready"})
	})
	mux.HandleFunc("GET /api/environments/{rid}/{vno}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"rid": r.PathValue("rid"), "vno": 1, "status": "ready"})
	})
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		refuse := u.refuse
		u.mu.Unlock()
		if refuse == nil || !refuse(w, r) {
			mux.ServeHTTP(w, r)
		}
	}))
	t.Cleanup(u.Close)
	return u
}

// controls lists the pause and resume calls the unit received, in order.
func (u *fakeUnit) controls() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.controlled...)
}

// compiles counts the plans the unit was asked to compile.
func (u *fakeUnit) compiles() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.compiled
}

// lastResultNamespace is the namespace the last rows request named.
func (u *fakeUnit) lastResultNamespace() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.resultNamespace
}

func (u *fakeUnit) starts() []map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]map[string]any(nil), u.started...)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// harness is a catalog on the test database with memory adapters and a fake unit.
type harness struct {
	t         *testing.T
	svc       *catalog.Service
	srv       *server.Server
	http      *httptest.Server
	relay     *authz.Relay
	unit      *fakeUnit
	secrets   *memory.Secrets
	workloads *memory.Workloads
	lake      *memory.Lake
	router    routers.Router
	doc       *openapi3.T
}

type outbox struct{ st *store.Store }

func (o outbox) PendingOutbox(ctx context.Context, limit int) ([]authz.OutboxEntry, error) {
	entries, err := o.st.PendingOutbox(ctx, limit)
	if err != nil {
		return nil, err
	}
	out := make([]authz.OutboxEntry, len(entries))
	for i, e := range entries {
		out[i] = authz.OutboxEntry{ID: e.ID, Op: e.Op, Object: e.Object, Relation: e.Relation, Subject: e.Subject}
	}
	return out, nil
}

func (o outbox) MarkOutboxProcessed(ctx context.Context, ids []int64) error {
	return o.st.MarkOutboxProcessed(ctx, ids)
}

func (o outbox) AllTuples(ctx context.Context) ([]authz.OutboxEntry, error) {
	entries, err := o.st.AllTuples(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]authz.OutboxEntry, len(entries))
	for i, e := range entries {
		out[i] = authz.OutboxEntry{Op: e.Op, Object: e.Object, Relation: e.Relation, Subject: e.Subject}
	}
	return out, nil
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	url := os.Getenv("TEXERA_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://texera:texera@localhost:15432/catalog_test?sslmode=disable"
	}
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		if os.Getenv("TEXERA_TEST_REQUIRE_DB") != "" {
			t.Fatalf("postgres: %v", err)
		}
		t.Skipf("postgres not available: %v", err)
	}
	t.Cleanup(st.Close)
	if err := st.Reset(ctx); err != nil {
		t.Fatal(err)
	}
	if err := st.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authorizer := memory.NewAuthorizer()
	pdp := authz.NewPDP(authorizer, log)
	relay := authz.NewRelay(outbox{st}, authorizer, log)
	unit := newFakeUnit(t)
	secrets := memory.NewSecrets()
	workloads := memory.NewWorkloads()
	lake := memory.NewLake()
	svc := &catalog.Service{
		Store: st, PDP: pdp, Relay: relay, Identity: fakeIdentity{}, Secrets: secrets, Blobs: memory.NewBlobs(), Units: memory.Units{}, Workloads: workloads, Lake: lake, LineageSink: &memory.Lineage{},
		Config: catalog.Config{PublicURL: "http://test", APIPrefix: server.Prefix, OIDCIssuer: "http://test/auth/realms/texera", OIDCClientID: "texera-app", BrandName: "Texera Test",
			IcebergCatalogURI: "http://lakekeeper/catalog", IcebergWarehouse: "texera", LineageCallbackURL: "http://catalog/lineage/v1/events",
			PresignTTL: time.Hour, LeaseTTL: time.Hour, MaxDownloadBytes: 1 << 20,
			StaticUnitEndpoint: unit.URL, StaticUnitName: "test unit", StaticUnitClientID: "texera-unit", BioMcpURL: "http://test/bio-mcp", BioMcpKey: "bio-dev-key", ModelName: "claude-haiku-5-5", ModelSecretPath: "platform/anthropic"},
		Log: log,
	}
	if err := svc.Seed(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := relay.Once(ctx); err != nil {
		t.Fatal(err)
	}
	resolver := auth.NewResolver(fakeIdentity{}, st, isUnitClient)
	srv := server.New(svc, resolver, pdp, "http://test", log)
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)

	doc, err := api.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	doc.Servers = nil
	router, err := gorillamux.NewRouter(doc)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, svc: svc, srv: srv, http: hs, relay: relay, unit: unit, secrets: secrets, workloads: workloads, lake: lake, router: router, doc: doc}
}

// do sends a request as the token's user, relays the outbox, and validates the request and
// the response against the OpenAPI document.
func (h *harness) do(token, method, path string, body any, headers ...string) (int, []byte) {
	h.t.Helper()
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(b)
		contentType = "application/octet-stream"
	case string:
		reader = strings.NewReader(b)
		contentType = "application/octet-stream"
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
		contentType = "application/json"
	}
	req, err := http.NewRequest(method, h.http.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if err := h.relay.Once(context.Background()); err != nil {
		h.t.Fatal(err)
	}
	h.validate(req, body, resp, data)
	return resp.StatusCode, data
}

// validate checks the response against the contract; a route the document does not have is
// a failure, except the gateway's own endpoints.
func (h *harness) validate(req *http.Request, body any, resp *http.Response, data []byte) {
	h.t.Helper()
	if !strings.HasPrefix(req.URL.Path, server.Prefix) && !strings.HasPrefix(req.URL.Path, "/lineage/") && !strings.HasPrefix(req.URL.Path, "/access/v1/evaluation") {
		return
	}
	route, pathParams, err := h.router.FindRoute(req)
	if err != nil {
		h.t.Errorf("%s %s: not in the OpenAPI document: %v", req.Method, req.URL.Path, err)
		return
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return
	}
	input := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: &openapi3filter.RequestValidationInput{Request: req, PathParams: pathParams, Route: route, Options: &openapi3filter.Options{AuthenticationFunc: openapi3filter.NoopAuthenticationFunc}},
		Status:                 resp.StatusCode,
		Header:                 resp.Header,
		Body:                   io.NopCloser(bytes.NewReader(data)),
		Options:                &openapi3filter.Options{IncludeResponseStatus: true},
	}
	if err := openapi3filter.ValidateResponse(context.Background(), input); err != nil {
		h.t.Errorf("%s %s -> %d: response does not match the contract: %v\n%s", req.Method, req.URL.Path, resp.StatusCode, err, truncate(data))
	}
}

func truncate(data []byte) string {
	if len(data) > 800 {
		return string(data[:800]) + "..."
	}
	return string(data)
}

// json decodes a successful response into out and returns the status.
func (h *harness) json(token, method, path string, body any, out any, headers ...string) int {
	h.t.Helper()
	status, data := h.do(token, method, path, body, headers...)
	if out != nil && status < 300 && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			h.t.Fatalf("%s %s: %v: %s", method, path, err, data)
		}
	}
	return status
}

// mustJSON is like json but fails on a non-2xx status.
func (h *harness) mustJSON(token, method, path string, body any, out any, headers ...string) {
	h.t.Helper()
	status, data := h.do(token, method, path, body, headers...)
	if status >= 300 {
		h.t.Fatalf("%s %s: %d %s", method, path, status, data)
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			h.t.Fatalf("%s %s: %v: %s", method, path, err, data)
		}
	}
}

// envelope is a resource as the API renders it.
type envelope = api.Resource

func (h *harness) create(token, plural, name string, spec any) envelope {
	h.t.Helper()
	var out envelope
	h.mustJSON(token, "POST", server.Prefix+"/"+plural, map[string]any{"name": name, "spec": spec}, &out)
	return out
}

func rid(e envelope) string { return string(e.Metadata.Rid) }

// mustDecode reads a JSON document into out.
func mustDecode(t *testing.T, raw any, out any) {
	t.Helper()
	b, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		t.Fatal(err)
	}
}

func field(e envelope, key string) any {
	if e.Status == nil {
		return nil
	}
	return (*e.Status)[key]
}

// mustJSONBytes renders a value as JSON for comparisons.
func mustJSONBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
