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

package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/apache/texera/catalog/internal/api"
)

// A watch is the live side of sharing: whoever may read a resource sees it change, as
// server-sent events. A conversation shared with an editor is thereby a group chat, with no
// model of its own: the messages carry their authors and the turn lock names its holder. An
// execution shows its progress and answers to pause and resume through the catalog alone.

type sseEvent struct {
	Event string
	Data  json.RawMessage
}

// stream opens a watch as the token's user. A refusal returns its status and no channel; an
// open stream returns 200 and a channel that closes when the stream ends.
func (h *harness) stream(ctx context.Context, token, path string) (int, <-chan sseEvent) {
	h.t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.http.URL+path, nil)
	if err != nil {
		h.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		h.validate(req, nil, resp, data)
		return resp.StatusCode, nil
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		h.t.Fatalf("content type %q", ct)
	}
	ch := make(chan sseEvent, 64)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev.Event != "" {
					ch <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, "event: "):
				ev.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.Data = append(ev.Data, strings.TrimPrefix(line, "data: ")...)
			}
		}
	}()
	return http.StatusOK, ch
}

// next returns the data of the next event of the given type, skipping the others.
func next(t *testing.T, ch <-chan sseEvent, event string) json.RawMessage {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				t.Fatalf("the stream ended before a %s event", event)
			}
			if ev.Event == event {
				return ev.Data
			}
		case <-deadline:
			t.Fatalf("no %s event within 10s", event)
		}
	}
}

// nextResource returns the next resource event whose status satisfies ok.
func nextResource(t *testing.T, ch <-chan sseEvent, ok func(envelope) bool) envelope {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var e envelope
		mustDecode(t, next(t, ch, "resource"), &e)
		if ok(e) {
			return e
		}
	}
	t.Fatal("no resource event matched within 10s")
	return envelope{}
}

// ended reports whether the stream closed within a short while.
func ended(ch <-chan sseEvent) bool {
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

func TestWatchMakesASharedChatAGroupChat(t *testing.T) {
	h := newHarness(t)
	alice, bob := principalOf(h, "alice"), principalOf(h, "bob")
	conv := h.create("alice", "conversations", "team chat", map[string]any{})
	path := p + "/conversations/" + rid(conv)
	events := p + "/resources/" + rid(conv) + "/events"
	var first api.Message
	h.mustJSON("alice", "POST", path+"/messages", map[string]any{"role": "user", "parts": []any{map[string]any{"type": "text", "text": "hello"}}}, &first)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Nobody but a reader watches, and nobody anonymous.
	if status, _ := h.stream(ctx, "bob", events); status != http.StatusNotFound && status != http.StatusForbidden {
		t.Fatalf("bob may not watch alice's chat: %d", status)
	}
	if status, _ := h.stream(ctx, "", events); status != http.StatusUnauthorized {
		t.Fatalf("anonymous: %d", status)
	}

	// Alice's stream opens with the messages she asked for, then the conversation itself.
	status, aliceCh := h.stream(ctx, "alice", events+"?after=0")
	if status != http.StatusOK {
		t.Fatalf("alice: %d", status)
	}
	var replayed api.Message
	mustDecode(t, next(t, aliceCh, "message"), &replayed)
	if replayed.Seq != first.Seq || string(replayed.Author) != alice {
		t.Fatalf("replayed: %+v", replayed)
	}
	var opening envelope
	mustDecode(t, next(t, aliceCh, "resource"), &opening)
	if opening.Kind != "conversation" || field(opening, "messages") != float64(1) {
		t.Fatalf("opening: %+v", opening)
	}

	// A viewer reads and watches, and may not write: sharing's rule holds in the chat.
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(conv)+"/grants/"+bob, map[string]any{"relation": "viewer"}, nil)
	status, bobCh := h.stream(ctx, "bob", events+"?after="+itoa(first.Seq))
	if status != http.StatusOK {
		t.Fatalf("bob as viewer: %d", status)
	}
	mustDecode(t, next(t, bobCh, "resource"), &opening)
	if status, _ := h.do("bob", "POST", path+"/messages", map[string]any{"role": "user", "parts": []any{}}); status != http.StatusForbidden {
		t.Fatalf("a viewer may not post: %d", status)
	}
	if status, _ := h.do("bob", "POST", path+"/turns", map[string]any{}); status != http.StatusForbidden {
		t.Fatalf("a viewer may not take a turn: %d", status)
	}

	// An editor is a member: his turn and his message reach alice's stream under his name.
	h.mustJSON("alice", "PUT", p+"/resources/"+rid(conv)+"/grants/"+bob, map[string]any{"relation": "editor"}, nil)
	var turn api.Turn
	h.mustJSON("bob", "POST", path+"/turns", map[string]any{}, &turn)
	if status, body := h.do("alice", "POST", path+"/turns", map[string]any{}); status != http.StatusConflict {
		t.Fatalf("one turn at a time: %d %s", status, body)
	}
	locked := nextResource(t, aliceCh, func(e envelope) bool { return field(e, "activeTurn") != nil })
	if field(locked, "activeTurn") != turn.Turn || field(locked, "activeTurnBy") != bob {
		t.Fatalf("the lock names its holder: %v", locked.Status)
	}
	var bobs api.Message
	h.mustJSON("bob", "POST", path+"/messages", map[string]any{"turn": turn.Turn, "role": "user", "parts": []any{map[string]any{"type": "text", "text": "hi from bob"}}}, &bobs)
	var seen api.Message
	mustDecode(t, next(t, aliceCh, "message"), &seen)
	if seen.Seq != bobs.Seq || string(seen.Author) != bob || seen.Parts[0].Text == nil || *seen.Parts[0].Text != "hi from bob" {
		t.Fatalf("alice sees bob's message: %+v", seen)
	}
	mustDecode(t, next(t, bobCh, "message"), &seen)
	if seen.Seq != bobs.Seq {
		t.Fatalf("bob sees his own message: %+v", seen)
	}
	// A message rewritten as a turn streams reaches the others as the same seq.
	h.mustJSON("bob", "PUT", path+"/messages/"+itoa(bobs.Seq), map[string]any{"parts": []any{map[string]any{"type": "text", "text": "hi from bob, revised"}}}, nil)
	mustDecode(t, next(t, aliceCh, "message"), &seen)
	if seen.Seq != bobs.Seq || *seen.Parts[0].Text != "hi from bob, revised" {
		t.Fatalf("rewrite: %+v", seen)
	}
	if status, _ := h.do("bob", "DELETE", path+"/turns/"+turn.Turn, nil); status != http.StatusNoContent {
		t.Fatalf("end turn: %d", status)
	}
	unlocked := nextResource(t, aliceCh, func(e envelope) bool { return field(e, "activeTurn") == nil })
	if field(unlocked, "activeTurnBy") != nil {
		t.Fatalf("the holder goes with the lock: %v", unlocked.Status)
	}

	// Deleting the conversation ends every stream.
	if status, _ := h.do("alice", "DELETE", p+"/resources/"+rid(conv), nil); status != http.StatusNoContent {
		t.Fatalf("delete: %d", status)
	}
	next(t, aliceCh, "deleted")
	if !ended(aliceCh) || !ended(bobCh) {
		t.Fatal("the streams end with the conversation")
	}
}

func TestWatchFollowsAnExecutionAndItsControls(t *testing.T) {
	h := newHarness(t)
	ds := h.create("alice", "datasets", "iris", map[string]any{"format": "csv"})
	h.mustJSON("alice", "PUT", p+"/datasets/"+rid(ds)+"/files/iris.csv", "Species,PetalLengthCm\nsetosa,1.4\n", nil)
	h.mustJSON("alice", "POST", p+"/datasets/"+rid(ds)+"/commit", map[string]any{}, nil)
	spec := map[string]any{
		"operators": []any{
			map[string]any{"operatorID": "scan", "operatorType": "CSVFileScan", "operatorProperties": map[string]any{"fileName": string(ds.Metadata.Uri) + "@1/files/iris.csv"}},
			map[string]any{"operatorID": "avg", "operatorType": "Aggregate", "viewResult": true, "operatorProperties": map[string]any{}},
		},
		"links": []any{map[string]any{"linkID": "l1", "source": map[string]any{"operatorID": "scan", "portID": "output-0"}, "target": map[string]any{"operatorID": "avg", "portID": "input-0"}}},
	}
	wf := h.create("alice", "workflows", "watched", spec)
	var exec envelope
	h.mustJSON("alice", "POST", p+"/workflows/"+rid(wf)+"/run", map[string]any{"name": "watched execution"}, &exec)
	execPath := p + "/workflows/" + rid(wf) + "/executions/" + rid(exec)
	deadline := time.Now().Add(10 * time.Second)
	for field(exec, "phase") != "running" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		h.mustJSON("alice", "GET", execPath, nil, &exec)
	}
	if field(exec, "phase") != "running" {
		t.Fatalf("phase: %v", exec.Status)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	status, ch := h.stream(ctx, "alice", p+"/resources/"+rid(exec)+"/events")
	if status != http.StatusOK {
		t.Fatalf("watch: %d", status)
	}
	nextResource(t, ch, func(e envelope) bool { return field(e, "phase") == "running" })

	// The unit reports progress as it goes; the watcher sees each operator's state and count.
	report := func(job, eventType string, runFacets map[string]any) {
		t.Helper()
		ev := map[string]any{"eventType": eventType, "eventTime": time.Now().UTC().Format(time.RFC3339), "producer": "test", "schemaURL": "https://openlineage.io/spec/1-0-5/OpenLineage.json",
			"run": map[string]any{"runId": rid(exec), "facets": runFacets}, "job": map[string]any{"namespace": "texera", "name": job}}
		if status, data := h.do("unit", "POST", "/lineage/v1/events", ev); status != http.StatusNoContent {
			t.Fatalf("event: %d %s", status, data)
		}
	}
	operator := func(opid, state string, tuples int) map[string]any {
		return map[string]any{"texera_operator": map[string]any{"opid": opid, "state": state, "tuples": tuples}}
	}
	scanOf := func(e envelope) map[string]any {
		ops, _ := field(e, "operators").(map[string]any)
		scan, _ := ops["scan"].(map[string]any)
		return scan
	}
	report(rid(exec)+"/scan", "RUNNING", operator("scan", "Running", 5))
	progressed := nextResource(t, ch, func(e envelope) bool { return scanOf(e)["tuples"] == float64(5) })
	if scanOf(progressed)["state"] != "Running" {
		t.Fatalf("progress: %v", progressed.Status)
	}

	// Pause goes to the unit; the phase follows the unit's own report, and the watcher sees it.
	var answer envelope
	h.mustJSON("alice", "POST", execPath+"/pause", nil, &answer)
	if field(answer, "phase") != "running" {
		t.Fatalf("the catalog does not pretend: %v", answer.Status)
	}
	if got := h.unit.controls(); len(got) != 1 || got[0] != "pause "+rid(exec) {
		t.Fatalf("unit controls: %v", got)
	}
	if status, body := h.do("alice", "POST", execPath+"/resume", nil); status != http.StatusConflict || !strings.Contains(string(body), "not_paused") {
		t.Fatalf("resume while running: %d %s", status, body)
	}
	report(rid(exec), "RUNNING", map[string]any{"texera_execution": map[string]any{"status": "paused"}})
	nextResource(t, ch, func(e envelope) bool { return field(e, "phase") == "paused" })
	if status, body := h.do("alice", "POST", execPath+"/pause", nil); status != http.StatusConflict || !strings.Contains(string(body), "not_running") {
		t.Fatalf("pause while paused: %d %s", status, body)
	}
	if status, _ := h.do("bob", "POST", execPath+"/resume", nil); status != http.StatusForbidden && status != http.StatusNotFound {
		t.Fatalf("bob may not control alice's execution: %d", status)
	}
	h.mustJSON("alice", "POST", execPath+"/resume", nil, &answer)
	if got := h.unit.controls(); len(got) != 2 || got[1] != "resume "+rid(exec) {
		t.Fatalf("unit controls: %v", got)
	}
	report(rid(exec), "START", map[string]any{"texera_execution": map[string]any{"status": "running"}})
	nextResource(t, ch, func(e envelope) bool { return field(e, "phase") == "running" })

	// The terminal report is the last word: progress that arrives after it changes nothing.
	report(rid(exec)+"/scan", "COMPLETE", operator("scan", "Completed", 7))
	report(rid(exec), "COMPLETE", map[string]any{"texera_execution": map[string]any{"status": "completed"}})
	nextResource(t, ch, func(e envelope) bool { return field(e, "phase") == "completed" })
	report(rid(exec)+"/scan", "RUNNING", operator("scan", "Running", 1))
	h.mustJSON("alice", "GET", execPath, nil, &exec)
	if scanOf(exec)["tuples"] != float64(7) || scanOf(exec)["state"] != "Completed" {
		t.Fatalf("late progress ignored: %v", exec.Status)
	}
	if status, _ := h.do("alice", "POST", execPath+"/pause", nil); status != http.StatusConflict {
		t.Fatalf("pause after the end: %d", status)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
