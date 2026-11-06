// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package authz

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/ports"
)

// The relay carries the catalog's grants to the authorizer. A request that changes a grant
// relays before it answers, and a timer relays what a failure left behind, so two relays can
// want the same entries at the same moment.

// pending is an outbox in memory, and the index the tuples come from.
type pending struct {
	mu      sync.Mutex
	entries []OutboxEntry
	done    map[int64]bool
	implied []OutboxEntry
}

func (p *pending) add(op, object, relation, subject string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.entries = append(p.entries, OutboxEntry{ID: int64(len(p.entries) + 1), Op: op, Object: object, Relation: relation, Subject: subject})
}

func (p *pending) PendingOutbox(_ context.Context, limit int) ([]OutboxEntry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []OutboxEntry
	for _, e := range p.entries {
		if !p.done[e.ID] && len(out) < limit {
			out = append(out, e)
		}
	}
	return out, nil
}

func (p *pending) MarkOutboxProcessed(_ context.Context, ids []int64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.done == nil {
		p.done = map[int64]bool{}
	}
	for _, id := range ids {
		p.done[id] = true
	}
	return nil
}

func (p *pending) AllTuples(context.Context) ([]OutboxEntry, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]OutboxEntry(nil), p.implied...), nil
}

// recorder is an authorizer that keeps what it was told and counts how often. Like OpenFGA it
// refuses a request that writes and deletes the same tuple. `hold`, when set, keeps the first
// write waiting until it is closed, and `began` tells that it has started.
type recorder struct {
	mu     sync.Mutex
	tuples map[ports.Tuple]bool
	wrote  map[ports.Tuple]int
	calls  int
	hold   chan struct{}
	began  chan struct{}
}

func newRecorder() *recorder {
	return &recorder{tuples: map[ports.Tuple]bool{}, wrote: map[ports.Tuple]int{}}
}

func (r *recorder) Check(context.Context, string, string, string) (bool, error) { return false, nil }

func (r *recorder) Write(_ context.Context, writes, deletes []ports.Tuple) error {
	r.mu.Lock()
	r.calls++
	first := r.calls == 1
	r.mu.Unlock()
	if first && r.hold != nil {
		close(r.began)
		<-r.hold
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	gone := map[ports.Tuple]bool{}
	for _, t := range deletes {
		gone[t] = true
	}
	for _, t := range writes {
		if gone[t] {
			return fmt.Errorf("%v is written and deleted in one request", t)
		}
	}
	for _, t := range writes {
		r.tuples[t] = true
		r.wrote[t]++
	}
	for _, t := range deletes {
		delete(r.tuples, t)
	}
	return nil
}

func (r *recorder) has(object, relation, subject string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tuples[ports.Tuple{Object: object, Relation: relation, Subject: subject}]
}

func (r *recorder) times(object, relation, subject string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.wrote[ports.Tuple{Object: object, Relation: relation, Subject: subject}]
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// Two requests relay at the same moment. Each entry reaches the authorizer once, and a
// request's relay returns only when its own entries are there: what it made is usable by the
// time it answers.
func TestRelaysDoNotOverlap(t *testing.T) {
	outbox, authorizer := &pending{}, newRecorder()
	authorizer.hold, authorizer.began = make(chan struct{}), make(chan struct{})
	relay := NewRelay(outbox, authorizer, quiet())
	ctx := context.Background()

	outbox.add("write", "resource:lab", "owner", "user:alice")
	first := make(chan struct{})
	go func() {
		relay.Flush(ctx)
		close(first)
	}()
	<-authorizer.began // the first relay is writing alice's lab

	outbox.add("write", "resource:notes", "owner", "user:bob")
	second := make(chan struct{})
	go func() {
		relay.Flush(ctx)
		close(second)
	}()
	select {
	case <-second:
		t.Fatalf("the second relay returned while the first was writing; bob's notes there: %v", authorizer.has("resource:notes", "owner", "user:bob"))
	case <-time.After(100 * time.Millisecond):
	}

	close(authorizer.hold)
	<-first
	<-second
	if !authorizer.has("resource:lab", "owner", "user:alice") || !authorizer.has("resource:notes", "owner", "user:bob") {
		t.Fatal("both owners are known to the authorizer once their relays returned")
	}
	if n := authorizer.times("resource:lab", "owner", "user:alice"); n != 1 {
		t.Errorf("alice's lab was written %d times", n)
	}
	if n := authorizer.times("resource:notes", "owner", "user:bob"); n != 1 {
		t.Errorf("bob's notes were written %d times", n)
	}
}

// Entries are applied in the order they were made. When one relay carries several about the
// same tuple, what the last of them says is what the authorizer is told.
func TestTheLastWordOnATupleWins(t *testing.T) {
	outbox, authorizer := &pending{}, newRecorder()
	relay := NewRelay(outbox, authorizer, quiet())
	// Shared and taken back at once; taken back and shared again.
	outbox.add("write", "resource:lab", "viewer", "user:bob")
	outbox.add("delete", "resource:lab", "viewer", "user:bob")
	outbox.add("write", "resource:notes", "viewer", "user:bob")
	outbox.add("delete", "resource:notes", "viewer", "user:bob")
	outbox.add("write", "resource:notes", "viewer", "user:bob")
	outbox.add("write", "resource:lab", "owner", "user:alice")

	if err := relay.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if authorizer.has("resource:lab", "viewer", "user:bob") {
		t.Error("a grant taken back is still there")
	}
	if !authorizer.has("resource:notes", "viewer", "user:bob") {
		t.Error("a grant given again is missing")
	}
	if !authorizer.has("resource:lab", "owner", "user:alice") {
		t.Error("the entry that travelled with them is missing")
	}
	if left, _ := outbox.PendingOutbox(context.Background(), 10); len(left) != 0 {
		t.Errorf("entries still pending: %v", left)
	}
}

// The authorizer is a copy of the catalog's index. A rebuild writes every tuple the index
// implies, which puts back what a relay lost, after what is still pending.
func TestARebuildPutsBackWhatTheAuthorizerLost(t *testing.T) {
	outbox, authorizer := &pending{}, newRecorder()
	relay := NewRelay(outbox, authorizer, quiet())
	ctx := context.Background()
	outbox.implied = []OutboxEntry{
		{Op: "write", Object: "resource:lab", Relation: "owner", Subject: "user:alice"},
		{Op: "write", Object: "resource:notes", Relation: "parent", Subject: "resource:lab"},
	}
	// A grant taken back and not relayed yet is not in the index any more: it goes.
	if err := authorizer.Write(ctx, []ports.Tuple{{Object: "resource:lab", Relation: "viewer", Subject: "user:bob"}}, nil); err != nil {
		t.Fatal(err)
	}
	outbox.add("delete", "resource:lab", "viewer", "user:bob")

	n, err := relay.Rebuild(ctx)
	if err != nil || n != 2 {
		t.Fatalf("rebuild: %d tuples, %v", n, err)
	}
	if !authorizer.has("resource:lab", "owner", "user:alice") || !authorizer.has("resource:notes", "parent", "resource:lab") {
		t.Error("what the index implies is not all there")
	}
	if authorizer.has("resource:lab", "viewer", "user:bob") {
		t.Error("the grant taken back is still there")
	}
}
