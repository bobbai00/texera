# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""A conversation shared with another person is a group chat, with nothing added to the
model: the grant is the membership, every message names its author, the turn lock names
its holder, and the watch (a resource's event stream) is how the others see it as it
happens. A viewer reads and watches but may not post; an editor is a member."""
from texera_e2e import chat
from texera_e2e.events import Watch


def test_a_shared_chat_is_a_group_chat(alice, bob, project, grants_guard):
    alice_pid, bob_pid = alice.pid(), bob.pid()
    crid = chat.conversation(alice, "team chat", project)
    first = alice.post(f"/conversations/{crid}/messages", {"role": "user", "parts": [{"type": "text", "text": "hello team"}]})
    assert first["author"] == alice_pid

    # Nobody but a reader watches, and the stream opens with what the watcher asked for.
    assert bob.status("GET", f"/resources/{crid}/events") in (403, 404)
    watch = Watch(alice, crid, after=0)
    assert watch.next("message")["seq"] == first["seq"], "the messages after `after` come first"
    assert watch.next("resource")["kind"] == "conversation"

    # A viewer reads and watches; writing is the editor's.
    grants_guard(crid, bob_pid, "viewer")
    assert bob.status("GET", f"/conversations/{crid}/messages") == 200
    bobs_watch = Watch(bob, crid, after=first["seq"])
    assert bobs_watch.next("resource")["kind"] == "conversation"
    assert bob.status("POST", f"/conversations/{crid}/messages", {"role": "user", "parts": []}) == 403
    assert bob.status("POST", f"/conversations/{crid}/turns", {}) == 403

    # An editor is a member: his turn locks the chat under his name, his message carries it.
    grants_guard(crid, bob_pid, "editor")
    turn = bob.post(f"/conversations/{crid}/turns", {})
    assert alice.status("POST", f"/conversations/{crid}/turns", {}) == 409, "one turn at a time, whoever asks"
    locked = watch.until(lambda r: r["status"].get("activeTurn") is not None)
    assert locked["status"]["activeTurn"] == turn["turn"] and locked["status"]["activeTurnBy"] == bob_pid
    bobs = bob.post(f"/conversations/{crid}/messages", {"turn": turn["turn"], "role": "user", "parts": [{"type": "text", "text": "hi from bob"}]})
    seen = watch.next("message")
    assert seen["seq"] == bobs["seq"] and seen["author"] == bob_pid and seen["parts"][0]["text"] == "hi from bob"
    assert bobs_watch.next("message")["seq"] == bobs["seq"]
    bob.put(f"/conversations/{crid}/messages/{bobs['seq']}", {"parts": [{"type": "text", "text": "hi from bob, revised"}]})
    assert watch.next("message")["parts"][0]["text"] == "hi from bob, revised", "a rewrite reaches the others as the same seq"
    bob.delete(f"/conversations/{crid}/turns/{turn['turn']}")
    unlocked = watch.until(lambda r: r["status"].get("activeTurn") is None)
    assert "activeTurnBy" not in unlocked["status"]
    assert [m["author"] for m in alice.get(f"/conversations/{crid}/messages")["items"]] == [alice_pid, bob_pid]
