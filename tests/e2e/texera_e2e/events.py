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

"""A resource's event stream (`GET /resources/{rid}/events`): the live side of sharing. The
stream opens with the resource (and a conversation's messages after `after`), then every
change as `resource`, `message` or `deleted` events."""
import json
import queue
import threading
import time
import urllib.request
from typing import Any, Callable, Iterator

from .client import Api


def events(api: Api, rid: str, after: int = 0, timeout: float = 120) -> Iterator[tuple[str, Any]]:
    """Yields (event, data) until the stream ends or `timeout` seconds pass."""
    url = f"{api.base}/resources/{rid}/events" + (f"?after={after}" if after else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api.token}", "Accept": "text/event-stream"})
    deadline = time.monotonic() + timeout
    with urllib.request.urlopen(req, timeout=max(30, timeout)) as r:
        event, data = None, []
        for raw in r:
            if time.monotonic() > deadline:
                return
            line = raw.decode().rstrip("\n")
            if line == "":
                if event:
                    yield event, json.loads("".join(data)) if data else None
                event, data = None, []
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())


class Watch:
    """A stream read on a thread, so a test can act and then wait for what its action caused."""

    def __init__(self, api: Api, rid: str, after: int = 0, timeout: float = 120):
        self.q: queue.Queue = queue.Queue()
        self.thread = threading.Thread(target=self._run, args=(api, rid, after, timeout), daemon=True)
        self.thread.start()

    def _run(self, api: Api, rid: str, after: int, timeout: float) -> None:
        try:
            for item in events(api, rid, after, timeout):
                self.q.put(item)
                if item[0] == "deleted":
                    break
        except Exception as e:  # noqa: BLE001 - reported to the waiting test
            self.q.put(("error", str(e)))
        self.q.put(("end", None))

    def next(self, event: str, timeout: float = 30) -> Any:
        """The data of the next event of this type; other events are skipped."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"no {event} event within {timeout}s")
            kind, data = self.q.get(timeout=remaining)
            if kind == "end":
                raise AssertionError(f"the stream ended before a {event} event")
            if kind == "error":
                raise AssertionError(f"the stream failed: {data}")
            if kind == event:
                return data

    def until(self, ok: Callable[[dict], bool], timeout: float = 60) -> dict:
        """The next `resource` event whose envelope satisfies `ok`."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"no resource event matched within {timeout}s")
            r = self.next("resource", remaining)
            if ok(r):
                return r

    def ended(self, timeout: float = 10) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                kind, _ = self.q.get(timeout=deadline - time.monotonic())
            except queue.Empty:
                return False
            if kind == "end":
                return True
        return False


def phase(envelope: dict) -> str:
    return (envelope.get("status") or {}).get("phase", "pending")
