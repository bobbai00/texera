// Package contracttest holds one suite per port. The memory adapters run them as unit tests;
// the real adapters run them against the dev stack under the integration tag, so a peer
// upgrade that breaks a protocol fails here first.
package contracttest

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/ports"
)

// SecretStore exercises put, get, overwrite and delete.
func SecretStore(t *testing.T, s ports.SecretStore) {
	t.Helper()
	ctx := context.Background()
	path := "contracttest/" + uuid.NewString()
	if _, err := s.Get(ctx, path); !errors.Is(err, ports.ErrSecretNotFound) {
		t.Fatalf("missing secret: %v", err)
	}
	if err := s.Put(ctx, path, map[string]string{"value": "k1", "note": "first"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, path)
	if err != nil || got["value"] != "k1" || got["note"] != "first" {
		t.Fatalf("get: %v %v", got, err)
	}
	if err := s.Put(ctx, path, map[string]string{"value": "k2"}); err != nil {
		t.Fatal(err)
	}
	got, err = s.Get(ctx, path)
	if err != nil || got["value"] != "k2" || got["note"] != "" {
		t.Fatalf("overwrite: %v %v", got, err)
	}
	if err := s.Delete(ctx, path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, path); !errors.Is(err, ports.ErrSecretNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if err := s.Delete(ctx, path); err != nil {
		t.Fatalf("deleting twice: %v", err)
	}
}

// BlobStore exercises put once, exists, ranged get and presign.
func BlobStore(t *testing.T, b ports.BlobStore) {
	t.Helper()
	ctx := context.Background()
	digest := "sha256:" + strings.Repeat("0", 56) + uuid.NewString()[:8]
	data := "sepal_length,sepal_width\n5.1,3.5\n"
	if ok, err := b.Exists(ctx, digest); err != nil || ok {
		t.Fatalf("exists before put: %v %v", ok, err)
	}
	if _, err := b.Get(ctx, digest, 0, 0); !errors.Is(err, ports.ErrBlobNotFound) {
		t.Fatalf("get before put: %v", err)
	}
	if err := b.Put(ctx, digest, int64(len(data)), strings.NewReader(data), "text/csv"); err != nil {
		t.Fatal(err)
	}
	if err := b.Put(ctx, digest, int64(len(data)), strings.NewReader("different bytes, same digest: ignored"), "text/csv"); err != nil {
		t.Fatalf("second put: %v", err)
	}
	if ok, err := b.Exists(ctx, digest); err != nil || !ok {
		t.Fatalf("exists after put: %v %v", ok, err)
	}
	rc, err := b.Get(ctx, digest, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	all, _ := io.ReadAll(rc)
	rc.Close()
	if string(all) != data {
		t.Fatalf("get: %q", all)
	}
	rc, err = b.Get(ctx, digest, 13, 11)
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(rc)
	rc.Close()
	if string(part) != "sepal_width" {
		t.Fatalf("range: %q", part)
	}
	url, err := b.Presign(ctx, digest, "iris.csv", time.Minute)
	if err != nil || url == "" {
		t.Fatalf("presign: %q %v", url, err)
	}
}

// Authorizer exercises direct relations, the hierarchy, parent inheritance, the public
// wildcard, group membership and deletes.
func Authorizer(t *testing.T, a ports.Authorizer) {
	t.Helper()
	ctx := context.Background()
	suffix := uuid.NewString()
	alice, bob, carol := "user:alice-"+suffix, "user:bob-"+suffix, "user:carol-"+suffix
	project, workflow, run := "resource:project-"+suffix, "resource:workflow-"+suffix, "resource:run-"+suffix
	group := "group:admins-" + suffix
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	check := func(subject, perm, object string) bool {
		t.Helper()
		ok, err := a.Check(ctx, subject, perm, object)
		if err != nil {
			t.Fatalf("check %s %s %s: %v", subject, perm, object, err)
		}
		return ok
	}
	must(a.Write(ctx, []ports.Tuple{
		{Object: project, Relation: "owner", Subject: alice},
		{Object: workflow, Relation: "parent", Subject: project},
		{Object: run, Relation: "parent", Subject: workflow},
		{Object: workflow, Relation: "viewer", Subject: bob},
		{Object: group, Relation: "member", Subject: carol},
	}, nil))
	// Let the store settle (OpenFGA is consistent after a write, the suite waits a little anyway).
	time.Sleep(50 * time.Millisecond)
	if !check(alice, "can_read", run) || !check(alice, "can_write", run) || !check(alice, "can_share", workflow) || !check(alice, "can_delete", project) {
		t.Fatal("the owner of the project should own what is under it")
	}
	if !check(bob, "can_read", workflow) || !check(bob, "can_execute", workflow) || !check(bob, "can_read", run) {
		t.Fatal("a viewer reads and executes the workflow and reads its runs")
	}
	if check(bob, "can_write", workflow) || check(bob, "can_read", project) || check(bob, "can_share", workflow) {
		t.Fatal("a viewer neither writes nor shares, and sees nothing above")
	}
	if check(carol, "can_read", workflow) {
		t.Fatal("carol has nothing yet")
	}
	must(a.Write(ctx, []ports.Tuple{{Object: workflow, Relation: "editor", Subject: group + "#member"}}, nil))
	time.Sleep(50 * time.Millisecond)
	if !check(carol, "can_write", workflow) || !check(carol, "can_rotate", workflow) {
		t.Fatal("a group editor writes through membership")
	}
	must(a.Write(ctx, []ports.Tuple{{Object: workflow, Relation: "viewer", Subject: "user:*"}}, nil))
	time.Sleep(50 * time.Millisecond)
	if !check("user:stranger-"+suffix, "can_read", workflow) || !check("user:stranger-"+suffix, "can_use", workflow) {
		t.Fatal("public means everyone reads and uses")
	}
	must(a.Write(ctx, nil, []ports.Tuple{{Object: workflow, Relation: "viewer", Subject: "user:*"}, {Object: workflow, Relation: "viewer", Subject: bob}}))
	time.Sleep(50 * time.Millisecond)
	if check(bob, "can_read", workflow) || check("user:stranger-"+suffix, "can_read", workflow) {
		t.Fatal("revoked")
	}
	must(a.Write(ctx, nil, []ports.Tuple{{Object: workflow, Relation: "viewer", Subject: bob}}))
}
