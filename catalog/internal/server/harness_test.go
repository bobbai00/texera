package server_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/apache/texera/catalog/internal/authn"
	"github.com/apache/texera/catalog/internal/authz"
	"github.com/apache/texera/catalog/internal/config"
	"github.com/apache/texera/catalog/internal/datasets"
	"github.com/apache/texera/catalog/internal/mcp"
	"github.com/apache/texera/catalog/internal/server"
	"github.com/apache/texera/catalog/internal/store"
)

// issuer is a minimal OIDC provider: discovery, JWKS and a client-credentials token endpoint.
type issuer struct {
	srv *httptest.Server
	key *rsa.PrivateKey
}

func newIssuer(t *testing.T) *issuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	iss := &issuer{key: key}
	mux := http.NewServeMux()
	iss.srv = httptest.NewServer(mux)
	t.Cleanup(iss.srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"issuer": iss.srv.URL, "jwks_uri": iss.srv.URL + "/jwks", "token_endpoint": iss.srv.URL + "/token",
			"authorization_endpoint": iss.srv.URL + "/auth", "response_types_supported": []string{"code"},
			"subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		pub := key.PublicKey
		writeJSON(w, map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"access_token": iss.service(), "expires_in": 3600, "token_type": "Bearer"})
	})
	return iss
}

func (i *issuer) mint(claims jwt.MapClaims) string {
	now := time.Now()
	base := jwt.MapClaims{"iss": i.srv.URL, "aud": "texera", "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	for k, v := range claims {
		base[k] = v
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, base)
	tok.Header["kid"] = "test"
	s, err := tok.SignedString(i.key)
	if err != nil {
		panic(err)
	}
	return s
}

// user mints a person's token, as the app's login would get it.
func (i *issuer) user(name string) string {
	return i.mint(jwt.MapClaims{"sub": "sub-" + name, "preferred_username": name, "email": name + "@texera.test", "azp": "texera-app"})
}

// service mints the platform service client's token.
func (i *issuer) service() string {
	return i.mint(jwt.MapClaims{"sub": "sub-service", "azp": "texera-services"})
}

// fakeUnit stands in for a computing unit: it compiles trivially, accepts executions and reports
// OpenLineage events back to the catalog the way the engine does.
type fakeUnit struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	starts []map[string]any
	fail   bool
	// tables records the `table` each result read named.
	tables []string
}

func (u *fakeUnit) resultTables() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.tables...)
}

func newFakeUnit(t *testing.T) *fakeUnit {
	u := &fakeUnit{t: t}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"status": "ok"}) })
	mux.HandleFunc("GET /api/operators", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeJSON(w, map[string]any{"groups": []any{}, "operators": []any{
			map[string]any{"operatorType": "CSVFileScan", "userFriendlyName": "CSV File Scan", "operatorGroupName": "Data Input",
				"jsonSchema": map[string]any{"properties": map[string]any{"fileName": map[string]any{"type": "string"}}}, "inputPorts": []any{}, "outputPorts": []any{map[string]any{}}},
			map[string]any{"operatorType": "Aggregate", "userFriendlyName": "Aggregate", "operatorGroupName": "Aggregate",
				"jsonSchema": map[string]any{}, "inputPorts": []any{map[string]any{}}, "outputPorts": []any{map[string]any{}}},
		}})
	})
	mux.HandleFunc("POST /api/compile", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "operatorErrors": map[string]any{},
			"operatorOutputSchemas": map[string]any{"scan": map[string]any{"output-0": []any{map[string]any{"attributeName": "a", "attributeType": "string"}}}}})
	})
	mux.HandleFunc("POST /api/executions", func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		u.mu.Lock()
		u.starts = append(u.starts, req)
		fail := u.fail
		u.mu.Unlock()
		eid := req["eid"].(string)
		writeJSON(w, map[string]any{"eid": eid, "accepted": true})
		go u.report(req, eid, fail)
	})
	mux.HandleFunc("GET /api/executions/{eid}/results/{opid}/{port}", func(w http.ResponseWriter, r *http.Request) {
		// 2^53 + 1 does not survive a float64: it checks that numbers pass through exactly.
		rows := [][]any{{"setosa", json.Number("9007199254740993"), nil}, {"virginica", json.Number("2"), "a, \"quoted\" note"}}
		u.mu.Lock()
		u.tables = append(u.tables, r.URL.Query().Get("table"))
		u.mu.Unlock()
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if offset > len(rows) {
			offset = len(rows)
		}
		end := len(rows)
		if limit > 0 && offset+limit < end {
			end = offset + limit
		}
		writeJSON(w, map[string]any{"schema": []any{
			map[string]any{"attributeName": "species", "attributeType": "string"},
			map[string]any{"attributeName": "count", "attributeType": "long"},
			map[string]any{"attributeName": "note", "attributeType": "string"},
		}, "rows": rows[offset:end], "offset": offset, "total": len(rows)})
	})
	u.srv = httptest.NewServer(mux)
	t.Cleanup(u.srv.Close)
	return u
}

func (u *fakeUnit) report(req map[string]any, eid string, fail bool) {
	reporting := req["reporting"].(map[string]any)
	url, token := reporting["lineageUrl"].(string), reporting["token"].(string)
	post := func(ev map[string]any) {
		ev["eventTime"] = time.Now().UTC().Format(time.RFC3339)
		ev["producer"], ev["schemaURL"] = "test", "https://openlineage.io/spec"
		body, _ := json.Marshal(ev)
		hr, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		hr.Header.Set("Authorization", "Bearer "+token)
		hr.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(hr)
		if err == nil {
			resp.Body.Close()
		}
	}
	run := func(status string) map[string]any {
		return map[string]any{"run": map[string]any{"runId": eid, "facets": map[string]any{"texera_execution": map[string]any{"status": status}}},
			"job": map[string]any{"namespace": "texera", "name": eid}}
	}
	ev := run("running")
	ev["eventType"] = "START"
	post(ev)
	if fail {
		ev = run("failed")
		ev["eventType"] = "FAIL"
		ev["run"].(map[string]any)["facets"].(map[string]any)["texera_execution"].(map[string]any)["error"] = map[string]any{"message": "boom"}
		post(ev)
		return
	}
	post(map[string]any{"eventType": "COMPLETE",
		"run": map[string]any{"runId": eid, "facets": map[string]any{"texera_operator": map[string]any{"opid": "scan", "state": "Completed", "tuples": 150}}},
		"job": map[string]any{"namespace": "texera", "name": eid + "/scan"}, "inputs": []any{},
		"outputs": []any{map[string]any{"namespace": "texera", "name": eid + "/scan/output-0"}}})
	post(map[string]any{"eventType": "COMPLETE",
		"run":    map[string]any{"runId": eid, "facets": map[string]any{"texera_operator": map[string]any{"opid": "avg", "state": "Completed", "tuples": 3}}},
		"job":    map[string]any{"namespace": "texera", "name": eid + "/avg"},
		"inputs": []any{map[string]any{"namespace": "texera", "name": eid + "/scan/output-0"}},
		"outputs": []any{map[string]any{"namespace": "texera", "name": eid + "/avg/output-0",
			"facets": map[string]any{"texera_port": map[string]any{"table": "vfs:///avg", "tupleCount": 3}}}}})
	ev = run("completed")
	ev["eventType"] = "COMPLETE"
	post(ev)
}

func (u *fakeUnit) lastStart() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.starts) == 0 {
		return nil
	}
	return u.starts[len(u.starts)-1]
}

// stack is a catalog wired to a test database, the issuer and the fake unit.
type stack struct {
	t      *testing.T
	srv    *httptest.Server
	store  *store.Store
	issuer *issuer
	unit   *fakeUnit
	server *server.Server
}

func newStack(t *testing.T) *stack {
	t.Helper()
	url := os.Getenv("TEXERA_TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://texera:texera@localhost:15432/catalog_test?sslmode=disable"
	}
	ctx := context.Background()
	st, err := store.Open(ctx, url)
	if err != nil {
		if os.Getenv("TEXERA_TEST_REQUIRE_DB") != "" {
			t.Fatalf("postgres not available: %v", err)
		}
		t.Skipf("postgres not available: %v", err)
	}
	t.Cleanup(st.Close)
	require.NoError(t, st.Reset(ctx))
	require.NoError(t, st.Migrate(ctx))

	iss := newIssuer(t)
	unit := newFakeUnit(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := &stack{t: t, store: st, issuer: iss, unit: unit}

	mux := http.NewServeMux()
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)

	cfg := config.Config{
		PublicURL: s.srv.URL, OIDCIssuer: iss.srv.URL, OIDCAudience: "texera", ServiceClientID: "texera-services",
		StaticUnitEndpoint: unit.srv.URL, StaticUnitName: "test unit", LineageCallbackURL: s.srv.URL + "/lineage/v1/events",
		IcebergCatalogURI: "http://iceberg.test/catalog", IcebergWarehouse: "texera", PresignTTL: time.Hour, MaxDownloadBytes: 1 << 20,
	}
	verifier, err := authn.NewVerifier(ctx, st, iss.srv.URL, "", "", "texera", "texera-services")
	require.NoError(t, err)
	tokens, err := authn.NewServiceTokenSource(ctx, iss.srv.URL, "", "texera-services", "secret")
	require.NoError(t, err)
	files := datasets.New(datasets.Options{Endpoint: newFakeS3(t).srv.URL, PublicEndpoint: "http://s3.test", Region: "us-east-1",
		AccessKey: "k", SecretKey: "s", Bucket: "datasets", PathStyle: true, PresignTTL: time.Hour})
	pdp := authz.NewPDP(st, nil, log)
	srv := server.New(server.Deps{Config: cfg, Store: st, PDP: pdp, Drainer: authz.NewDrainer(st, nil, log), Verifier: verifier, Tokens: tokens, Files: files, Log: log})
	require.NoError(t, srv.Seed(ctx))
	s.server = srv
	srv.Mount("/mcp", mcp.Handler(srv, verifier, cfg.PublicURL, log))
	mux.Handle("/", srv.Handler())
	return s
}

type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(r.body, &m), string(r.body))
	return m
}

func (s *stack) do(method, path, token string, body any, headers ...string) response {
	s.t.Helper()
	var rd io.Reader
	raw, isRaw := body.([]byte)
	switch {
	case isRaw:
		rd = bytes.NewReader(raw)
	case body != nil:
		b, err := json.Marshal(body)
		require.NoError(s.t, err)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, s.srv.URL+path, rd)
	require.NoError(s.t, err)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	switch {
	case isRaw:
		req.Header.Set("Content-Type", "application/octet-stream")
	case body != nil:
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(s.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return response{status: resp.StatusCode, header: resp.Header, body: b}
}

// ok asserts a 2xx and decodes the body.
func (s *stack) ok(method, path, token string, body any, headers ...string) map[string]any {
	s.t.Helper()
	r := s.do(method, path, token, body, headers...)
	require.Truef(s.t, r.status >= 200 && r.status < 300, "%s %s -> %d %s", method, path, r.status, string(r.body))
	if len(r.body) == 0 {
		return nil
	}
	return r.json(s.t)
}

func (s *stack) whoami(token string) (pid string, home string) {
	me := s.ok("GET", "/catalog/v1/me", token, nil)
	return me["principal"].(map[string]any)["pid"].(string), me["homeProject"].(string)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func content(ops ...map[string]any) map[string]any {
	return map[string]any{"operators": ops, "links": []any{}}
}

func op(id, typ string, props map[string]any) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	return map[string]any{"operatorID": id, "operatorType": typ, "operatorProperties": props}
}

func mustUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	require.NoError(t, err)
	return id
}

var _ = fmt.Sprintf
var _ = strings.TrimSpace
