package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// A finished run can be deleted, and goes with its tables; a run still going cannot. The
// retention policy expires the results of old runs (the record stays, the rows are gone) and
// removes blobs nothing names.
func TestRetention(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "viewResult": true, "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}}},
		"links":     []any{},
	}
	wf := h.create("alice", "workflows", "kept for a while", spec)
	run := func(name string) envelope {
		var exec envelope
		h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": name}, &exec)
		return exec
	}
	namespace := func(e envelope) string { return "e_" + strings.ReplaceAll(rid(e), "-", "") }
	execPath := func(e envelope) string { return p + "/workflows/" + rid(wf) + "/executions/" + rid(e) }

	// Deleting: refused while the run goes, done once it is cancelled; the namespace goes too.
	first := run("first")
	if status, body := h.do("alice", "DELETE", execPath(first), nil); status != http.StatusConflict {
		t.Fatalf("a run still going: %d %s", status, body)
	}
	h.mustJSON("alice", "POST", execPath(first)+"/cancel", map[string]any{}, nil)
	if status, body := h.do("bob", "DELETE", execPath(first), nil); status != http.StatusForbidden {
		t.Fatalf("bob may not delete alice's run: %d %s", status, body)
	}
	if status, body := h.do("alice", "DELETE", execPath(first), nil); status != http.StatusNoContent {
		t.Fatalf("delete: %d %s", status, body)
	}
	if status, _ := h.do("alice", "GET", execPath(first), nil); status != http.StatusNotFound {
		t.Fatalf("the run is gone: %d", status)
	}
	dropped := false
	for _, ns := range h.lake.Dropped {
		dropped = dropped || ns == namespace(first)
	}
	if !dropped {
		t.Fatalf("the namespace is dropped with the run: %v", h.lake.Dropped)
	}

	// Expiry: a finished run older than the policy loses its tables and keeps its record.
	second := run("second")
	h.mustJSON("alice", "POST", execPath(second)+"/cancel", map[string]any{}, nil)
	var settings envelope
	h.mustJSON("admin", "GET", p+"/settings", nil, &settings)
	withPolicy := func(results, blobs string) {
		policy := map[string]any{}
		if results != "" {
			policy["results"] = results
		}
		if blobs != "" {
			policy["blobs"] = blobs
		}
		s := map[string]any{}
		mustDecode(t, settings.Spec, &s)
		if len(policy) > 0 {
			s["retention"] = policy
		} else {
			delete(s, "retention")
		}
		h.mustJSON("admin", "PUT", p+"/settings", map[string]any{"spec": s}, nil)
	}
	if status, body := h.do("alice", "POST", p+"/settings/retention/sweep", nil); status != http.StatusForbidden {
		t.Fatalf("a sweep is the administrator's: %d %s", status, body)
	}
	var sweep api.RetentionSweep
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.ExecutionsExpired != 0 {
		t.Fatalf("without a policy nothing expires: %+v", sweep)
	}
	withPolicy("PT0S", "")
	time.Sleep(20 * time.Millisecond)
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.ExecutionsExpired != 1 {
		t.Fatalf("the finished run expires: %+v", sweep)
	}
	if h.lake.OpenedFor(namespace(second)) != "" {
		t.Fatal("the expired run's namespace is dropped")
	}
	var after envelope
	h.mustJSON("alice", "GET", execPath(second), nil, &after)
	var st api.ExecutionStatus
	mustDecode(t, after.Status, &st)
	if st.ResultsExpiredAt == nil || st.Phase != api.ExecutionPhaseCancelled {
		t.Fatalf("the record stays, marked expired: %+v", st)
	}
	if status, body := h.do("alice", "GET", execPath(second)+"/operators/scan/ports/output-0/rows", nil); status != http.StatusGone {
		t.Fatalf("the rows are gone: %d %s", status, body)
	}
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.ExecutionsExpired != 0 {
		t.Fatalf("an expired run is not expired again: %+v", sweep)
	}

	// Blobs: a file uploaded and taken back again is nobody's; the policy removes it.
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/scratch.csv", "a\n1\n", nil)
	var staged api.Manifest
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/staged", nil, &staged)
	digest := ""
	for _, f := range staged.Files {
		if f.Path == "scratch.csv" {
			digest = string(f.Sha256)
		}
	}
	if digest == "" {
		t.Fatalf("the staged file: %+v", staged)
	}
	if status, body := h.do("alice", "DELETE", p+"/datasets/"+rid(ds)+"/files/scratch.csv", nil); status/100 != 2 {
		t.Fatalf("unstage: %d %s", status, body)
	}
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.BlobsDeleted != 0 {
		t.Fatalf("a day's grace for fresh uploads: %+v", sweep)
	}
	withPolicy("", "PT0S")
	time.Sleep(20 * time.Millisecond)
	h.mustJSON("admin", "POST", p+"/settings/retention/sweep", nil, &sweep)
	if sweep.BlobsDeleted != 1 {
		t.Fatalf("the unreferenced blob goes: %+v", sweep)
	}
	if exists, _ := h.svc.Blobs.Exists(context.Background(), digest); exists {
		t.Fatal("the bytes are gone from the blob store")
	}
	// The committed file's blob stays: a version names it.
	h.mustJSON("alice", "GET", p+"/datasets/"+rid(ds)+"/versions/1/files", nil, &staged)
	if len(staged.Files) != 1 {
		t.Fatalf("the committed manifest: %+v", staged)
	}
	if exists, _ := h.svc.Blobs.Exists(context.Background(), string(staged.Files[0].Sha256)); !exists {
		t.Fatal("a blob a version names is kept")
	}
	withPolicy("", "")
}
