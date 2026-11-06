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
from texera_e2e.client import Api
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


def test_a_note_is_a_message_of_no_turn_and_a_turn_is_not_needed_to_say_it(alice, bob, project, grants_guard):
    """A member says something to the others without asking the agent: a message of no turn,
    under their name. It can be said while someone else's turn runs, and takes no turn."""
    bob_pid = bob.pid()
    crid = chat.conversation(alice, "notes", project)
    grants_guard(crid, bob_pid, "editor")
    watch = Watch(alice, crid)
    watch.next("resource")

    turn = alice.post(f"/conversations/{crid}/turns", {})
    note = bob.post(f"/conversations/{crid}/messages", {"role": "user", "parts": [{"type": "text", "text": "use the 2020 data"}]})
    assert note["author"] == bob_pid and "turn" not in note
    assert watch.next("message")["seq"] == note["seq"], "the others see it as it is said"
    status = alice.get(f"/conversations/{crid}")["status"]
    assert status["activeTurn"] == turn["turn"] and status["activeTurnBy"] == alice.pid(), "the turn under way is untouched"
    alice.delete(f"/conversations/{crid}/turns/{turn['turn']}")


def test_a_workflows_live_document_is_the_live_services_to_keep(alice, bob, service, gw, project, grants_guard):
    """The document people edit at once is loaded and saved by the platform's live service
    alone: a person neither reads nor writes it, and only the service saves a version in the
    names of the people whose edits it holds."""
    alice_pid, bob_pid = alice.pid(), bob.pid()
    rid = alice.create("workflows", "edited together", {"operators": [], "links": []}, project=project)["metadata"]["rid"]
    grants_guard(rid, bob_pid, "editor")
    live = Api(gw, service)

    for who in (alice, bob):
        assert who.status("GET", f"/resources/{rid}/live") == 403
        assert who.status("PUT", f"/resources/{rid}/live", {"basedOn": 1, "state": "AQID"}) == 403
    assert live.status("GET", f"/resources/{rid}/live") == 404, "nothing is kept before the first session"
    live.put(f"/resources/{rid}/live", {"basedOn": 1, "state": "AQID"})
    kept = live.get(f"/resources/{rid}/live")
    assert (kept["basedOn"], kept["state"]) == (1, "AQID")

    spec = {"operators": [{"operatorID": "top", "operatorType": "Limit", "operatorProperties": {"limit": 5}}], "links": []}
    assert alice.status("POST", f"/workflows/{rid}/edit", {"spec": spec, "onBehalfOf": [bob_pid]}) == 403, "nobody saves in another's name"
    saved = live.post(f"/workflows/{rid}/edit", {"spec": spec, "expectedHead": 1, "onBehalfOf": [bob_pid, alice_pid]})
    assert saved["vno"] == 2 and saved["createdBy"] == bob_pid and saved["contributors"] == [bob_pid, alice_pid]
    newest = alice.get(f"/workflows/{rid}/versions")["items"][0]
    assert (newest["vno"], newest["createdBy"], newest["contributors"]) == (2, bob_pid, [bob_pid, alice_pid])
    # A version one person saved names nobody else.
    own = alice.post(f"/workflows/{rid}/edit", {"spec": {"operators": [], "links": []}, "expectedHead": 2})
    assert own["createdBy"] == alice_pid and "contributors" not in own
    # An agent that read the head before someone changed it is refused, not applied to the wrong spec.
    assert alice.status("POST", f"/workflows/{rid}/edit", {"patch": [{"op": "remove", "path": "/operators/0"}], "expectedHead": 2}) == 409
