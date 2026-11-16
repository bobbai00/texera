"""A tiny OIDC issuer that stands in for the Dashboard service (Step 0 proof only).

Lakekeeper trusts this issuer: it reads the discovery document, fetches the
JWKS and verifies RS256 tokens against it. The proof's runner asks this issuer
for tokens the same way a unit would receive one from the Dashboard service.

Endpoints
  GET  /.well-known/openid-configuration  discovery document
  GET  /jwks.json                         public keys (only the published ones)
  GET  /minimal/.well-known/openid-configuration, /minimal/jwks.json
                                          the same keys behind a discovery document that holds
                                          only issuer + jwks_uri (issuer = ISSUER_URL + "/minimal")
  GET  /health                            liveness
  POST /mint                              mint a token, body (all optional except sub):
         sub        subject (required)
         aud        string or list, default DEFAULT_AUDIENCE
         exp_in     seconds from now until exp (negative = already expired), default 600
         nbf_in     seconds from now for nbf (omitted unless given)
         iss        override the issuer claim
         kid        override the kid header
         key        "current" (default), a published kid, or "rogue" (a key that is never published)
         alg        "RS256" (default), "none" (unsigned) or "HS256" (HMAC keyed with the public key PEM,
                    the classic algorithm-confusion attack)
         claims     extra claims to merge in
         omit       list of claim names to leave out
       -> {"token": "...", "kid": "...", "exp": <epoch seconds>}
  POST /rotate                            body {"mode": "add" | "retire-old"}
         add        generate a new key, publish it next to the old ones and sign with it from now on
         retire-old stop publishing every key except the current one

Keys exist only in this process's memory; nothing here logs or returns private key material.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ISSUER_URL = os.environ.get("ISSUER_URL", "http://sce0tok-issuer:8080").rstrip("/")
DEFAULT_AUDIENCE = os.environ.get("DEFAULT_AUDIENCE", "texera-lake")
PORT = int(os.environ.get("PORT", "8080"))

_lock = threading.Lock()


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def int_b64u(value: int) -> str:
    return b64u(value.to_bytes((value.bit_length() + 7) // 8, "big"))


def new_key():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nums = key.public_key().public_numbers()
    # RFC 7638 thumbprint as the kid, so it is stable for a key and reveals nothing secret.
    thumb_input = json.dumps({"e": int_b64u(nums.e), "kty": "RSA", "n": int_b64u(nums.n)},
                             separators=(",", ":"), sort_keys=True).encode()
    kid = b64u(hashlib.sha256(thumb_input).digest())[:16]
    return kid, key


class KeyRing:
    def __init__(self):
        kid, key = new_key()
        self.keys = {kid: key}          # every key this issuer ever made
        self.published = [kid]          # kids served in the JWKS
        self.current = kid              # kid used to sign by default
        _, self.rogue = new_key()       # never published

    def jwks(self):
        out = []
        for kid in self.published:
            nums = self.keys[kid].public_key().public_numbers()
            out.append({"kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid,
                        "n": int_b64u(nums.n), "e": int_b64u(nums.e)})
        return {"keys": out}

    def rotate(self, mode):
        if mode == "add":
            kid, key = new_key()
            self.keys[kid] = key
            self.published.append(kid)
            self.current = kid
        elif mode == "retire-old":
            self.published = [self.current]
        else:
            raise ValueError("unknown rotate mode")
        return {"current": self.current, "published": list(self.published)}


RING = KeyRing()


def mint(req):
    sub = req.get("sub")
    if not sub:
        raise ValueError("sub is required")
    now = int(time.time())
    claims = {
        "iss": req.get("iss", ISSUER_URL),
        "sub": sub,
        "aud": req.get("aud", DEFAULT_AUDIENCE),
        "iat": now,
        "exp": now + int(req.get("exp_in", 600)),
        "jti": secrets.token_hex(8),
    }
    if "nbf_in" in req:
        claims["nbf"] = now + int(req["nbf_in"])
    claims.update(req.get("claims") or {})
    for name in req.get("omit") or []:
        claims.pop(name, None)

    alg = req.get("alg", "RS256")
    key_sel = req.get("key", "current")
    with _lock:
        if key_sel == "rogue":
            key = RING.rogue
            kid = RING.current
        else:
            kid = RING.current if key_sel == "current" else key_sel
            key = RING.keys[kid]
        kid = req.get("kid", kid)

    header = {"alg": alg, "typ": "JWT"}
    if kid is not None:
        header["kid"] = kid
    signing_input = (b64u(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     b64u(json.dumps(claims, separators=(",", ":")).encode())).encode("ascii")
    if alg == "RS256":
        sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    elif alg == "none":
        sig = b""
    elif alg == "HS256":
        pem = key.public_key().public_bytes(serialization.Encoding.PEM,
                                            serialization.PublicFormat.SubjectPublicKeyInfo)
        sig = hmac.new(pem, signing_input, hashlib.sha256).digest()
    else:
        raise ValueError("unsupported alg")
    return {"token": signing_input.decode("ascii") + "." + b64u(sig), "kid": kid,
            "exp": claims.get("exp")}


def discovery():
    return {
        "issuer": ISSUER_URL,
        "jwks_uri": ISSUER_URL + "/jwks.json",
        "authorization_endpoint": ISSUER_URL + "/authorize",
        "token_endpoint": ISSUER_URL + "/token",
        "response_types_supported": ["code", "token", "id_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "grant_types_supported": ["client_credentials"],
    }


def minimal_discovery():
    # The least a discovery document can hold: who the issuer is and where its keys are.
    # Served under /minimal so a second Lakekeeper can be pointed at it.
    return {"issuer": ISSUER_URL + "/minimal", "jwks_uri": ISSUER_URL + "/minimal/jwks.json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "sce0tok-issuer/1"

    def log_message(self, fmt, *args):  # request line + status only, never headers or bodies
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/.well-known/openid-configuration":
            self._send(200, discovery())
        elif path == "/minimal/.well-known/openid-configuration":
            self._send(200, minimal_discovery())
        elif path in ("/jwks.json", "/minimal/jwks.json"):
            with _lock:
                self._send(200, RING.jwks())
        elif path == "/health":
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            if path == "/mint":
                self._send(200, mint(req))
            elif path == "/rotate":
                with _lock:
                    self._send(200, RING.rotate(req.get("mode", "add")))
            else:
                self._send(404, {"error": "not found"})
        except (ValueError, KeyError) as exc:
            self._send(400, {"error": type(exc).__name__, "detail": str(exc)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
