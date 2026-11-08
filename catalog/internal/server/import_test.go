package server_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/apache/texera/catalog/internal/api"
	"github.com/apache/texera/catalog/internal/catalog"
)

const cohortCSV = "Pregnancies,Glucose,Outcome\n6,148,1\n1,85,0\n"

// source is a file server of a test's own, over TLS, that counts what reaches it.
func source(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/data/diabetes.csv":
			// A server often calls a CSV plain text.
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = io.WriteString(w, cohortCSV)
		case "/moved":
			http.Redirect(w, r, "http://"+r.Host+"/data/diabetes.csv", http.StatusFound)
		case "/big.csv":
			_, _ = io.WriteString(w, strings.Repeat("x", 4096))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

// A dataset takes a file from the internet as it takes an upload: the catalog fetches it into
// the staging area, under the URL's file name or a path given, and a commit makes the version.
// What it may not fetch it refuses before fetching anything, and what fails to come in whole
// is not staged.
func TestADatasetImportsAFileFromTheInternet(t *testing.T) {
	h := newHarness(t)
	src, hits := source(t)
	h.svc.Importer = src.Client()
	ds := h.create("alice", "datasets", "cohort", map[string]any{"format": "csv"})
	base := p + "/datasets/" + rid(ds)

	var f api.DatasetFile
	h.mustJSON("alice", "POST", base+"/import", map[string]any{"url": src.URL + "/data/diabetes.csv"}, &f)
	if f.Path != "diabetes.csv" || f.Size != int64(len(cohortCSV)) || f.ContentType == nil || *f.ContentType != "text/csv" {
		t.Fatalf("staged under the URL's name, as a CSV: %+v", f)
	}
	h.mustJSON("alice", "POST", base+"/commit", map[string]any{"message": "the cohort, from " + src.URL}, nil)
	if status, body := h.do("alice", "GET", base+"/versions/1/files/diabetes.csv", nil); status != http.StatusOK || string(body) != cohortCSV {
		t.Fatalf("the version holds the file's bytes: %d %q", status, body)
	}
	h.mustJSON("alice", "POST", base+"/import", map[string]any{"url": src.URL + "/data/diabetes.csv", "path": "raw/pima.csv"}, &f)
	if f.Path != "raw/pima.csv" {
		t.Fatalf("staged at the path given: %+v", f)
	}

	// Refused before anything is fetched.
	fetched := hits.Load()
	for _, c := range []struct {
		body map[string]any
		says string
	}{
		{map[string]any{"url": "http://example.org/a.csv"}, "only https is fetched"},
		{map[string]any{"url": "https://someone:secret@example.org/a.csv"}, "a user and password do not go in a URL"},
		{map[string]any{"url": "https://example.org/"}, "the URL names no file"},
		{map[string]any{"url": "nothing like a URL"}, "not a URL"},
	} {
		status, body := h.do("alice", "POST", base+"/import", c.body)
		if status != http.StatusBadRequest || !strings.Contains(string(body), c.says) {
			t.Fatalf("%v: want 400 saying %q, got %d %s", c.body, c.says, status, body)
		}
	}
	if status, _ := h.do("bob", "POST", base+"/import", map[string]any{"url": src.URL + "/data/diabetes.csv"}); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Fatalf("someone who may not write it imports nothing: %d", status)
	}
	if got := hits.Load(); got != fetched {
		t.Fatalf("nothing refused reached the server: %d requests", got-fetched)
	}

	// Fetched and refused: the server's own refusal, a redirect to plain http, a file over the
	// limit. None of them is staged.
	h.svc.Config.ImportMaxBytes = 1024
	for _, c := range []struct{ url, says string }{
		{src.URL + "/nothing.csv", "answered 404"},
		{src.URL + "/moved", "which is not https"},
		{src.URL + "/big.csv", "more than the 1024 bytes an import takes"},
	} {
		status, body := h.do("alice", "POST", base+"/import", map[string]any{"url": c.url})
		if status != http.StatusBadRequest || !strings.Contains(string(body), c.says) {
			t.Fatalf("%s: want 400 saying %q, got %d %s", c.url, c.says, status, body)
		}
	}
	var staged api.Manifest
	h.mustJSON("alice", "GET", base+"/staged", nil, &staged)
	if len(staged.Files) != 1 || staged.Files[0].Path != "raw/pima.csv" {
		t.Fatalf("only what came in whole is staged: %+v", staged.Files)
	}
}

// The client imports fetch with connects to the public internet only: a server on this machine,
// reached by name, gets no request, and neither does a private, link-local or reserved address.
func TestAnImportReachesOnlyThePublicInternet(t *testing.T) {
	h := newHarness(t)
	src, hits := source(t)
	ds := h.create("alice", "datasets", "cohort", map[string]any{"format": "csv"})
	// By name, so only the address it resolves to says where it is.
	byName := strings.Replace(src.URL, "127.0.0.1", "localhost", 1) + "/data/diabetes.csv"
	status, body := h.do("alice", "POST", p+"/datasets/"+rid(ds)+"/import", map[string]any{"url": byName})
	if status != http.StatusBadRequest || !strings.Contains(string(body), "is not on the public internet") || hits.Load() != 0 {
		t.Fatalf("a server on this machine is refused before it is reached: %d %s, %d requests", status, body, hits.Load())
	}
	if _, err := catalog.PublicClient().Get(src.URL + "/data/diabetes.csv"); err == nil || !strings.Contains(err.Error(), "is not on the public internet") || hits.Load() != 0 {
		t.Fatalf("the client refuses the connection itself: %v", err)
	}
	// An address written out is refused before any connection: a private one, the loopback,
	// the cloud's metadata service.
	for _, u := range []string{"https://10.1.2.3/a.csv", "https://[::1]/a.csv", "https://169.254.169.254/latest/meta-data"} {
		status, body := h.do("alice", "POST", p+"/datasets/"+rid(ds)+"/import", map[string]any{"url": u})
		if status != http.StatusBadRequest || !strings.Contains(string(body), "is not on the public internet") {
			t.Fatalf("%s: %d %s", u, status, body)
		}
	}

	for addr, public := range map[string]bool{
		"8.8.8.8": true, "140.82.112.3": true, "2606:4700:4700::1111": true, "::ffff:8.8.8.8": true,
		"127.0.0.1": false, "10.0.0.1": false, "172.16.5.4": false, "192.168.1.1": false, "169.254.169.254": false,
		"100.64.0.1": false, "0.0.0.0": false, "198.18.0.1": false, "224.0.0.1": false, "255.255.255.255": false,
		"::1": false, "::": false, "fd00::1": false, "fe80::1": false, "ff02::1": false, "::ffff:127.0.0.1": false,
		"::ffff:10.0.0.1": false, "64:ff9b::a00:1": false, "2002:a00:1::": false, "2001:db8::1": false,
	} {
		if got := catalog.PublicAddress(netip.MustParseAddr(addr)); got != public {
			t.Errorf("%s public %v, want %v", addr, got, public)
		}
	}
}
