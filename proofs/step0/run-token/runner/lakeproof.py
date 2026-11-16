"""Helpers for the run-token proof: endpoints, the issuer client, a Lakekeeper
client that records every call it makes, S3 helpers for vended credentials, and
the check/result bookkeeping that prints one PASS/FAIL line per check.

Nothing here prints a token, a key or a secret. Calls are logged as
method + path template + status only.
"""

import base64
import json
import os
import re
import time
from urllib.parse import urlsplit

import boto3
import botocore
import requests
from botocore.config import Config

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

LK = "http://127.0.0.1:19500"            # Lakekeeper, published port
ISSUER = "http://127.0.0.1:19504"        # Dashboard stand-in, published port
S3_HOST = "http://127.0.0.1:19501"       # RustFS as the runner (on the host) reaches it
S3_IN_NET = "sce0tok-rustfs:9000"        # RustFS as Lakekeeper (and a unit) reaches it
BUCKET = "sce0tok-lake"
KEY_PREFIX = "wh"
WAREHOUSE = "lake"
AUDIENCE = "texera-lake"
REGION = "us-east-1"
DASHBOARD_SUB = "texera-dashboard"

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def load_secrets():
    path = os.path.join(ROOT, "state", "secrets.env")
    out = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


# --------------------------------------------------------------------------- results

class Results:
    """Collects checks and notes; prints one line per check as it is decided."""

    def __init__(self):
        self.checks = []
        self.notes = []
        self.setup = []

    def step(self, name, ok, detail=""):
        self.setup.append({"name": name, "ok": bool(ok), "detail": detail})
        print("SETUP %-4s %s%s" % ("ok" if ok else "FAIL", name, (" -- " + detail) if detail else ""), flush=True)
        if not ok:
            raise SystemExit("setup step failed: " + name)

    def check(self, cid, name, ok, detail=""):
        self.checks.append({"id": cid, "name": name, "ok": bool(ok), "detail": detail})
        print("%s  %-4s %s%s" % ("PASS" if ok else "FAIL", cid, name, (" -- " + detail) if detail else ""), flush=True)
        return ok

    def note(self, name, detail):
        self.notes.append({"name": name, "detail": detail})
        print("NOTE  %s -- %s" % (name, detail), flush=True)


# --------------------------------------------------------------------------- call log

class CallLog:
    """Records method + templated path + status for every HTTP call, per actor."""

    def __init__(self):
        self.calls = []
        self.names = {}  # id -> placeholder

    def name(self, ident, placeholder):
        self.names[ident] = placeholder

    def template(self, path):
        for ident, ph in self.names.items():
            path = path.replace(ident, ph)
        return UUID_RE.sub("{uuid}", path)

    @staticmethod
    def summarize(body):
        """What a request body asked for, without any values that could be secret:
        assignment bodies list type + principal; anything else lists its top-level keys."""
        if not body:
            return ""
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            return "(non-json body)"
        if not isinstance(data, dict):
            return ""
        if "writes" in data or "deletes" in data:
            parts = []
            for kind in ("writes", "deletes"):
                items = data.get(kind) or []
                if items:
                    parts.append("%s=[%s]" % (kind, ", ".join(
                        "%s:%s" % (i.get("type"), i.get("user") or ("role " + str(i.get("role")))) for i in items)))
            return " ".join(parts)
        if "managed-access" in data:
            return "managed-access=%s" % data["managed-access"]
        return "keys=" + ",".join(sorted(data.keys()))

    def hook(self, actor):
        def _hook(resp, *args, **kwargs):
            req = resp.request
            self.calls.append({
                "actor": actor,
                "method": req.method,
                "path": self.template(urlsplit(req.url).path),
                "body": self.summarize(req.body),
                "status": resp.status_code,
                "t": time.time(),
            })
        return _hook


class Lake:
    """A Lakekeeper HTTP client bound to one identity (bearer token)."""

    def __init__(self, token, actor, log):
        self.actor = actor
        self.s = requests.Session()
        self.s.headers["Authorization"] = "Bearer " + token
        self.s.hooks["response"].append(log.hook(actor))

    def get(self, path, **kw):
        return self.s.get(LK + path, timeout=30, **kw)

    def post(self, path, body=None, **kw):
        return self.s.post(LK + path, json=body, timeout=60, **kw)

    def delete(self, path, **kw):
        return self.s.delete(LK + path, timeout=30, **kw)

    def head(self, path, **kw):
        return self.s.head(LK + path, timeout=30, **kw)


def err_type(resp):
    """Short description of a response: status plus Lakekeeper's error type."""
    if resp.status_code < 400:
        return str(resp.status_code)
    try:
        e = resp.json().get("error", {})
        return "%d %s" % (resp.status_code, e.get("type") or e.get("message", "")[:60])
    except ValueError:
        return "%d %s" % (resp.status_code, resp.text[:60].strip())


def refused(resp):
    return resp.status_code in (401, 403, 404)


# --------------------------------------------------------------------------- issuer

def mint(sub, **kw):
    body = {"sub": sub}
    body.update(kw)
    r = requests.post(ISSUER + "/mint", json=body, timeout=10)
    r.raise_for_status()
    return r.json()


def rotate(mode):
    r = requests.post(ISSUER + "/rotate", json={"mode": mode}, timeout=10)
    r.raise_for_status()
    return r.json()


def wait_http(url, timeout=120, ok=(200,)):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if requests.get(url, timeout=3).status_code in ok:
                return True
        except requests.RequestException:
            pass
        time.sleep(1)
    return False


# --------------------------------------------------------------------------- storage

def vended(load_result):
    """The vended S3 credential set from a LoadTableResult (storage-credentials first)."""
    for sc in load_result.get("storage-credentials") or []:
        cfg = sc.get("config") or {}
        if "s3.access-key-id" in cfg:
            return dict(cfg, prefix=sc.get("prefix"))
    cfg = load_result.get("config") or {}
    return dict(cfg) if "s3.access-key-id" in cfg else None


def s3_for(creds):
    cfg = Config(s3={"addressing_style": "path"}, signature_version="s3v4",
                 retries={"max_attempts": 1}, connect_timeout=5, read_timeout=15)
    return boto3.client("s3", endpoint_url=S3_HOST, region_name=REGION, config=cfg,
                        aws_access_key_id=creds["s3.access-key-id"],
                        aws_secret_access_key=creds["s3.secret-access-key"],
                        aws_session_token=creds.get("s3.session-token"))


def s3_try(fn):
    """Run an S3 call; return 'ALLOWED' or 'DENIED(<code>)'."""
    try:
        fn()
        return "ALLOWED"
    except botocore.exceptions.ClientError as exc:
        return "DENIED(%s)" % exc.response.get("Error", {}).get("Code", "?")


def key_of(location):
    """s3://bucket/key -> key"""
    assert location.startswith("s3://%s/" % BUCKET), location
    return location[len("s3://%s/" % BUCKET):]


def sts_claims(session_token):
    """RustFS session tokens are JWTs (as in MinIO). Read exp, parent and the
    session policy -- the claims only, never the token itself."""
    parts = session_token.split(".")
    if len(parts) != 3:
        return None
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    policy = payload.get("sessionPolicy")
    if isinstance(policy, str):
        try:
            policy = json.loads(base64.b64decode(policy + "=" * (-len(policy) % 4)))
        except ValueError:
            pass
    return {"exp": payload.get("exp"), "parent": payload.get("parent"), "policy": policy}


def remote_sign(lake, load_result, method, key):
    """Ask Lakekeeper to sign one S3 request (the Iceberg S3 remote-signing protocol).
    Returns (sign_response, signed_headers or None)."""
    cfg = load_result["config"]
    url = cfg["s3.signer.uri"].rstrip("/") + "/" + cfg["s3.signer.endpoint"].lstrip("/")
    body = {"region": REGION, "uri": "http://%s/%s/%s" % (S3_IN_NET, BUCKET, key), "method": method,
            "headers": {"x-amz-content-sha256": ["UNSIGNED-PAYLOAD"]}}
    r = lake.s.post(url, json=body, timeout=30)
    if r.status_code != 200:
        return r, None
    headers = {k: v[0] for k, v in r.json()["headers"].items() if k.lower() != "cache-control"}
    headers["Host"] = S3_IN_NET
    return r, (r.json()["uri"], headers)


def send_signed(signed, method, data=None):
    uri, headers = signed
    u = urlsplit(uri)
    target = S3_HOST + u.path + (("?" + u.query) if u.query else "")
    return requests.request(method, target, headers=headers, data=data, timeout=15)


# --------------------------------------------------------------------------- pyiceberg

def catalog(token, name, log):
    """A PyIceberg REST catalog for one identity, asking for vended credentials."""
    from pyiceberg.catalog.rest import RestCatalog

    class LoggedRestCatalog(RestCatalog):
        def _create_session(self):
            s = super()._create_session()
            s.hooks["response"].append(log.hook(name))
            return s

    return LoggedRestCatalog(name, **{
        "uri": LK + "/catalog",
        "warehouse": WAREHOUSE,
        "token": token,
        "header.X-Iceberg-Access-Delegation": "vended-credentials",
    })


def host_io(tbl):
    """Lakekeeper hands out the in-network S3 endpoint (sce0tok-rustfs:9000). The
    runner sits on the host, so point the table's FileIO at the published port.
    Credentials and paths are untouched; only the endpoint changes."""
    from pyiceberg.io.pyarrow import PyArrowFileIO
    tbl.io = PyArrowFileIO({**tbl.io.properties, "s3.endpoint": S3_HOST})
    return tbl
