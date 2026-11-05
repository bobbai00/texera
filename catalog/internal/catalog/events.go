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

package catalog

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/apache/texera/catalog/internal/auth"
	"github.com/apache/texera/catalog/internal/store"
)

// Broker hands every change of a resource to whoever watches it. It lives in the process: the
// catalog runs as one today. With replicas the same changes ride on Postgres LISTEN/NOTIFY and
// this type stays the fan-out on each side.
type Broker struct {
	mu   sync.Mutex
	subs map[uuid.UUID]map[*Subscription]struct{}
}

// Subscription is one watcher of one resource. A watcher that falls behind loses changes and
// is told so (Lost), so it can resynchronise from the store instead of blocking the writer.
type Subscription struct {
	C    <-chan store.Change
	ch   chan store.Change
	lost atomic.Bool
}

// Lost reports whether a change was dropped since the last call, and clears the flag.
func (s *Subscription) Lost() bool { return s.lost.Swap(false) }

// NewBroker makes an empty broker.
func NewBroker() *Broker { return &Broker{subs: map[uuid.UUID]map[*Subscription]struct{}{}} }

// Subscribe starts watching a resource; cancel stops.
func (b *Broker) Subscribe(rid uuid.UUID) (*Subscription, func()) {
	ch := make(chan store.Change, 256)
	sub := &Subscription{C: ch, ch: ch}
	b.mu.Lock()
	if b.subs[rid] == nil {
		b.subs[rid] = map[*Subscription]struct{}{}
	}
	b.subs[rid][sub] = struct{}{}
	b.mu.Unlock()
	return sub, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if set := b.subs[rid]; set != nil {
			delete(set, sub)
			if len(set) == 0 {
				delete(b.subs, rid)
			}
		}
	}
}

// Publish delivers a change to the resource's watchers without waiting for any of them.
func (b *Broker) Publish(c store.Change) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for sub := range b.subs[c.RID] {
		select {
		case sub.ch <- c:
		default:
			sub.lost.Store(true)
		}
	}
}

// Events is the service's broker, wired to the store's writes on the first call. The server
// calls it once before it serves, so the store's hook is set before any writer runs.
func (s *Service) Events() *Broker {
	s.eventsOnce.Do(func() {
		s.broker = NewBroker()
		s.Store.OnChange = s.broker.Publish
	})
	return s.broker
}

// Sender writes one server-sent event; an empty event is a comment that keeps the connection
// alive.
type Sender func(event string, data any) error

// Watch streams a resource to a caller who may read it, until the context ends, the resource
// is deleted or the caller loses the right to read it. It opens with the messages after
// `after` (a conversation) and the resource as it stands; then every change: `message` for a
// message appended or rewritten, `resource` for anything else, re-read through the caller's
// permissions. A watcher that fell behind is resynchronised from the store.
func (s *Service) Watch(ctx context.Context, caller *auth.Caller, rid uuid.UUID, after int64, send Sender) error {
	sub, cancel := s.Events().Subscribe(rid)
	defer cancel()
	res, err := s.Get(ctx, caller, nil, rid)
	if err != nil {
		return err
	}
	lastSeq := after
	replay := func() error {
		if res.Kind != "conversation" {
			return nil
		}
		for {
			msgs, err := s.Store.ListMessages(ctx, rid, lastSeq, 1000)
			if err != nil {
				return wrap(err, "conversation")
			}
			for i := range msgs {
				if err := send("message", MessageOf(&msgs[i])); err != nil {
					return err
				}
				lastSeq = msgs[i].Seq
			}
			if len(msgs) < 1000 {
				return nil
			}
		}
	}
	if err := replay(); err != nil {
		return err
	}
	if err := send("resource", Envelope(res)); err != nil {
		return err
	}
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-keepalive.C:
			if err := send("", nil); err != nil {
				return err
			}
		case c := <-sub.C:
			if c.Deleted {
				_ = send("deleted", map[string]any{"rid": rid.String()})
				return nil
			}
			if sub.Lost() {
				c.Message = nil
				if err := replay(); err != nil {
					return err
				}
			}
			if c.Message != nil {
				if c.Message.Seq > lastSeq {
					lastSeq = c.Message.Seq
				}
				if err := send("message", MessageOf(c.Message)); err != nil {
					return err
				}
				continue
			}
			if res, err = s.Get(ctx, caller, nil, rid); err != nil {
				return err
			}
			if err := send("resource", Envelope(res)); err != nil {
				return err
			}
		}
	}
}
