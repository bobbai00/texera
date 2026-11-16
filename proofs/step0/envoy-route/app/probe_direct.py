#!/usr/bin/env python3
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

"""Call a unit directly, bypassing Envoy, the way another unit or any process next to it could.

The unit must refuse every such call, because none of them carries its key:
no key at all, a made-up key, and a user's login (what a caller might try instead).
Standard library only, so it runs inside the unit image, a pod, or on the host.

  python -I probe_direct.py --mode compose http://sce0env-unit-a:8080
"""

import argparse
import sys
import urllib.error
import urllib.request


def status_of(url: str, headers: dict) -> int | str:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as err:
        return err.code
    except OSError as err:
        return f"error {type(err).__name__}"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--mode", required=True)
    p.add_argument("unit_url", help="the unit's app address, e.g. http://sce0env-unit-a:8080")
    args = p.parse_args()
    url = args.unit_url.rstrip("/") + "/api/units/1001/echo"
    attempts = {
        "no key": {},
        "made-up key": {"X-Texera-Unit-Key": "client-made-up-unit-key"},
        "user login only": {"Authorization": "Bearer login-alice"},
    }
    got = {label: status_of(url, headers) for label, headers in attempts.items()}
    ok = all(code == 401 for code in got.values())
    detail = ", ".join(f"{label} -> {code}" for label, code in got.items())
    print(f"{'PASS' if ok else 'FAIL'} [{args.mode}] direct-call-without-key-refused-by-unit: "
          f"bypassing Envoy: {detail}", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
