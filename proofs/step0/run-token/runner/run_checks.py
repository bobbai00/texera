"""Step 0 proof "run-token".

Claim: a token made for one run reaches only that run's namespace in the lake,
and stops working once its access is removed.

The runner plays two parts:
  * the Dashboard service (identity "texera-dashboard", the Lakekeeper operator):
    sets up the warehouse, creates the execution namespaces, grants and revokes;
  * a computing unit running execution 42 (identity "run-42"), which only holds
    the token the Dashboard minted for it.

Check ids:
  B*  the run token works inside e_42          C*  it is refused on e_43
  D*  what the vended storage credentials reach A*  tokens Lakekeeper must refuse
  G*  re-granting                               S*  remote signing
  E*  revocation                                K*  issuer key rotation
  P*  the narrower grant (create + select)      I*  the least an issuer must serve
  X*  long waits: STS expiry, JWKS cache (only with SCE0TOK_WAIT_STS_EXPIRY=1)
  L*  limits: PASS means the limitation was reproduced exactly as RESULTS.md
      describes it, so the plan has to work around it.

Prints SETUP/PASS/FAIL/NOTE lines; writes results/run-<timestamp>.json.
Exit status 0 only if every check passed.
"""

import datetime
import json
import os
import sys
import threading
import time

import pyarrow as pa

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lakeproof import (  # noqa: E402
    BUCKET, DASHBOARD_SUB, ISSUER, KEY_PREFIX, LK, REGION, ROOT, S3_IN_NET, WAREHOUSE,
    CallLog, Lake, Results, catalog, err_type, host_io, key_of, load_secrets, mint, refused,
    remote_sign, rotate, s3_for, s3_try, send_signed, sts_claims, vended, wait_http,
)

SCHEMA = pa.schema([("id", pa.int64()), ("v", pa.string())])
ICEBERG_SCHEMA = {"type": "struct", "schema-id": 0,
                  "fields": [{"id": 1, "name": "id", "required": False, "type": "long"}]}
LK_MIN = "http://127.0.0.1:19505"  # second Lakekeeper, trusting the issuer's minimal discovery document
VENDED = {"X-Iceberg-Access-Delegation": "vended-credentials"}
SIGNING = {"X-Iceberg-Access-Delegation": "remote-signing"}


def rows(table):
    return table.scan().to_arrow().num_rows


def ms(seconds):
    return "%.1f ms" % (seconds * 1000.0)


class Poller(threading.Thread):
    """Loads one table over and over with one token, recording (start, end, status),
    so a revocation can be placed precisely between the last success and the
    first refusal."""

    def __init__(self, token, path):
        super().__init__(daemon=True)
        import requests
        self.s = requests.Session()
        self.s.headers["Authorization"] = "Bearer " + token
        self.path = path
        self.samples = []
        self.stop = threading.Event()

    def run(self):
        while not self.stop.is_set():
            t0 = time.time()
            try:
                code = self.s.get(LK + self.path, timeout=10).status_code
            except Exception:  # noqa: BLE001 - record and keep polling
                code = -1
            self.samples.append((t0, time.time(), code))


def start_lakekeeper_without_issuer():
    """Start one more Lakekeeper with the running one's settings, except that its
    OpenID provider does not exist. Returns (exit code or None, seconds, error line).
    Secret values reach docker through its environment, never its arguments."""
    import subprocess
    name = "sce0tok-probe-lakekeeper"
    env_lines = subprocess.run(
        ["docker", "inspect", "sce0tok-lakekeeper", "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=True).stdout.splitlines()
    child_env = dict(os.environ)
    args = ["docker", "run", "-d", "--name", name, "--network", "sce0tok-net"]
    for line in env_lines:
        if line.startswith("LAKEKEEPER__") and "=" in line:
            key, value = line.split("=", 1)
            if key == "LAKEKEEPER__OPENID_PROVIDER_URI":
                value = "http://sce0tok-no-such-issuer:8080"
            child_env[key] = value
            args += ["-e", key]
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    subprocess.run(args + ["vakamo/lakekeeper:v0.11.0", "serve"], env=child_env, capture_output=True, check=True)
    t0 = time.time()
    code = None
    try:
        while time.time() - t0 < 30:
            state = subprocess.run(["docker", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", name],
                                   capture_output=True, text=True).stdout.split()
            if state and state[0] != "running" and state[0] != "created":
                code = int(state[1])
                break
            time.sleep(0.5)
        logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
        why = next((ln.strip() for ln in (logs.stdout + logs.stderr).splitlines() if ln.startswith("Error:")), "")
        return code, round(time.time() - t0, 1), why[:160]
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def until_refused(fn, timeout=60.0, interval=0.05):
    """Call fn() until Lakekeeper refuses. Returns (first response, seconds until the
    first refusal or None, attempts). With the default stack the first call is refused."""
    t0 = time.time()
    first, attempts = None, 0
    while True:
        r = fn()
        attempts += 1
        if first is None:
            first = r
        if refused(r):
            return first, time.time() - t0, attempts
        if time.time() - t0 > timeout:
            return first, None, attempts
        time.sleep(interval)


def delay_text(first, delay, attempts):
    if delay is None:
        return "still answered %s after 60 s" % err_type(first)
    if attempts == 1:
        return "refused on the first request (%s, %s)" % (err_type(first), ms(delay))
    return "first request still answered %s; refused only after %.1f s (%d attempts)" % (err_type(first), delay, attempts)


def revocation_window(samples, call_start, call_end):
    """Summarise poller samples around a revocation call."""
    before = [s for s in samples if s[1] <= call_start]
    after = [s for s in samples if s[0] >= call_end]
    during = [s for s in samples if s not in before and s not in after]
    last_ok = max((s for s in samples if s[2] == 200), key=lambda s: s[0], default=None)
    first_refused = min((s for s in samples if s[2] in (401, 403, 404)), key=lambda s: s[0], default=None)
    return {
        "samples": len(samples),
        "ok_before_call": sum(1 for s in before if s[2] == 200),
        "during_call": [s[2] for s in during],
        "ok_started_after_call": sum(1 for s in after if s[2] == 200),
        "refused_started_after_call": sum(1 for s in after if s[2] in (401, 403, 404)),
        "last_ok_start_rel_call_end_ms": None if last_ok is None else round((last_ok[0] - call_end) * 1000, 1),
        "first_refused_end_rel_call_end_ms": None if first_refused is None else round((first_refused[1] - call_end) * 1000, 1),
    }


def main():
    long_mode = os.environ.get("SCE0TOK_WAIT_STS_EXPIRY") == "1"
    sts_validity = int(os.environ.get("SCE0TOK_STS_VALIDITY", "900"))
    fga_cache = os.environ.get("SCE0TOK_FGA_CHECK_CACHE", "false")
    fga_store = os.environ.get("SCE0TOK_FGA_DATASTORE", "postgres")
    fga_ctl = os.environ.get("SCE0TOK_FGA_CACHE_CONTROLLER", "false")
    R = Results()
    log = CallLog()
    meta = {"started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "sts_validity_requested": sts_validity, "openfga_datastore": fga_store,
            "openfga_check_cache": fga_cache, "openfga_cache_controller": fga_ctl, "long_mode": long_mode}
    print("CONFIG openfga datastore=%s, openfga check cache=%s, cache controller=%s, "
          "warehouse sts-token-validity-seconds=%d, wait for STS expiry=%s" % (
              fga_store, fga_cache, fga_ctl, sts_validity, long_mode), flush=True)
    try:
        run_all(R, log, meta, long_mode, sts_validity)
    except SystemExit as exc:
        print("ABORT %s" % exc, flush=True)
    except Exception as exc:  # noqa: BLE001 - report, then fail the run
        import traceback
        traceback.print_exc()
        R.check("ERR", "runner crashed: %s: %s" % (type(exc).__name__, exc), False)
    finally:
        write_report(R, log, meta)
    failed = [c for c in R.checks if not c["ok"]]
    setup_failed = [s for s in R.setup if not s["ok"]]
    print("SUMMARY %d checks: %d PASS, %d FAIL%s" % (
        len(R.checks), len(R.checks) - len(failed), len(failed),
        " (setup failed)" if setup_failed else ""), flush=True)
    return 1 if failed or setup_failed or not R.checks else 0


def write_report(R, log, meta):
    os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(ROOT, os.environ.get("SCE0TOK_REPORT") or os.path.join("results", "run-%s.json" % stamp))
    with open(path, "w") as fh:
        json.dump({"meta": meta, "setup": R.setup, "checks": R.checks, "notes": R.notes,
                   "calls": [{k: v for k, v in c.items() if k != "t"} for c in log.calls]}, fh, indent=1)
    # The calls the Dashboard made (deduplicated), with what each body asked for.
    seen = []
    for c in log.calls:
        if c["actor"] == "dashboard":
            key = (c["method"], c["path"], c["status"], c.get("body", ""))
            if key not in seen:
                seen.append(key)
    print("CALLS made by the Dashboard identity (method, path, status, body summary):", flush=True)
    for m, p, s, b in seen:
        print("CALL  %-6s %-84s %s %s" % (m, p, s, b), flush=True)
    print("REPORT %s" % os.path.relpath(path, ROOT), flush=True)


def run_all(R, log, meta, long_mode, sts_validity):
    secrets = load_secrets()

    # ------------------------------------------------------------------ setup (Dashboard)
    R.step("issuer discovery reachable", wait_http(ISSUER + "/.well-known/openid-configuration", 60))
    dash_tok = mint(DASHBOARD_SUB, exp_in=7200)["token"]
    dash = Lake(dash_tok, "dashboard", log)
    r = dash.get("/management/v1/info")
    info = r.json() if r.ok else {}
    meta["lakekeeper"] = {k: info.get(k) for k in ("version", "authz-backend", "bootstrapped")}
    R.step("Lakekeeper accepts the Dashboard's token", r.status_code == 200 and info.get("authz-backend") == "openfga",
           "Lakekeeper %s, authz %s" % (info.get("version"), info.get("authz-backend")))
    r = dash.post("/management/v1/bootstrap", {"accept-terms-of-use": True, "is-operator": True,
                                               "user-type": "application", "user-name": DASHBOARD_SUB})
    R.step("bootstrap: the Dashboard identity becomes the server operator", r.status_code == 204, err_type(r))

    def s3_profile(validity):
        p = {"type": "s3", "bucket": BUCKET, "key-prefix": KEY_PREFIX, "region": REGION,
             "endpoint": "http://" + S3_IN_NET, "flavor": "s3-compat", "path-style-access": True,
             "sts-enabled": True}
        if validity is not None:
            p["sts-token-validity-seconds"] = validity
        return p

    s3_cred = {"type": "s3", "credential-type": "access-key",
               "aws-access-key-id": secrets["SCE0TOK_S3_LK_USER"],
               "aws-secret-access-key": secrets["SCE0TOK_S3_LK_PASSWORD"]}
    r = dash.post("/management/v1/warehouse", {"warehouse-name": WAREHOUSE, "storage-profile": s3_profile(sts_validity),
                                               "storage-credential": s3_cred})
    R.step("warehouse '%s' on RustFS with STS vending (validity %ds)" % (WAREHOUSE, sts_validity),
           r.status_code == 201, err_type(r))
    wid = r.json()["warehouse-id"]
    log.name(wid, "{warehouse_id}")
    C = "/catalog/v1/%s" % wid

    adm = catalog(dash_tok, "dashboard-iceberg", log)
    ids = {}

    def make_execution_namespace(ns):
        rr = dash.post(C + "/namespaces", {"namespace": [ns]})
        nsid = rr.json()["properties"]["namespace_id"] if rr.ok else None
        if nsid:
            log.name(nsid, "{%s_id}" % ns)
        t = host_io(adm.create_table("%s.t" % ns, schema=SCHEMA))
        t.append(pa.table({"id": [1, 2], "v": [ns + "-a", ns + "-b"]}, schema=SCHEMA))
        tid = str(t.metadata.table_uuid)
        log.name(tid, "{%s.t_id}" % ns)
        ids[ns] = {"ns": nsid, "t": tid, "loc": t.location(), "meta": t.metadata_location}
        return rr.ok and rows(host_io(adm.load_table("%s.t" % ns))) == 2

    ok = make_execution_namespace("e_42") and make_execution_namespace("e_43")
    R.step("namespaces e_42 and e_43, each with a 2-row table t", ok)

    # ------------------------------------------------------------------ grant (Dashboard)
    RUN, RUN_USER = "run-42", "oidc~run-42"
    grant = {"writes": [{"type": "create", "user": RUN_USER}, {"type": "modify", "user": RUN_USER}]}
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_42"]["ns"], grant)
    R.step("grant oidc~run-42 'create' + 'modify' on namespace e_42 only", r.status_code == 204, err_type(r))
    r = dash.post("/management/v1/user", {"id": RUN_USER, "name": RUN, "user-type": "application",
                                          "update-if-exists": True})
    R.step("provision user oidc~run-42 in Lakekeeper", r.status_code in (200, 201), err_type(r))
    run_tok = mint(RUN, exp_in=3600)["token"]
    run = Lake(run_tok, "run-42", log)

    # ------------------------------------------------------------------ B: inside e_42
    try:
        cat = catalog(run_tok, "run-42-iceberg", log)
        R.check("B1", "run token gets the catalog config for the warehouse", True)
    except Exception as exc:  # noqa: BLE001
        R.check("B1", "run token gets the catalog config for the warehouse", False, repr(exc)[:200])
        raise
    r = run.get(C + "/namespaces/e_42/tables")
    names = [i["name"] for i in r.json().get("identifiers", [])] if r.ok else []
    R.check("B2", "run token lists the tables of e_42", r.status_code == 200 and "t" in names, "%s %s" % (err_type(r), names))
    t42 = host_io(cat.load_table("e_42.t"))
    n = rows(t42)
    R.check("B3", "run token loads e_42.t and reads its data through vended credentials", n == 2, "rows=%d" % n)
    t42.append(pa.table({"id": [3], "v": ["written-by-run-42"]}, schema=SCHEMA))
    n = rows(host_io(cat.load_table("e_42.t")))
    R.check("B4", "run token appends to e_42.t (data files + commit)", n == 3, "rows=%d" % n)
    out = host_io(cat.create_table("e_42.run_out", schema=SCHEMA))
    out.append(pa.table({"id": [10, 11], "v": ["x", "y"]}, schema=SCHEMA))
    out_id = str(out.metadata.table_uuid)
    log.name(out_id, "{e_42.run_out_id}")
    n = rows(host_io(cat.load_table("e_42.run_out")))
    R.check("B5", "run token creates e_42.run_out, writes it and reads it back", n == 2, "rows=%d" % n)

    # ------------------------------------------------------------------ C: e_43 refused
    r = run.get(C + "/namespaces/e_43/tables/t", headers=VENDED)
    R.check("C1", "run token cannot load e_43.t", refused(r), err_type(r))
    try:
        cat.load_table("e_43.t")
        R.check("C1b", "PyIceberg load of e_43.t fails for the run", False, "loaded")
    except Exception as exc:  # noqa: BLE001
        R.check("C1b", "PyIceberg load of e_43.t fails for the run", True, type(exc).__name__)
    r = run.get(C + "/namespaces/e_43/tables")
    R.check("C2", "run token cannot list the tables of e_43", refused(r), err_type(r))
    r = run.post(C + "/namespaces/e_43/tables", {"name": "intruder", "schema": ICEBERG_SCHEMA})
    R.check("C3", "run token cannot create a table in e_43", refused(r), err_type(r))
    r = run.post(C + "/namespaces/e_43/tables/t", {"requirements": [], "updates": [
        {"action": "set-properties", "updates": {"written-by": "run-42"}}]})
    R.check("C4", "run token cannot commit to e_43.t", refused(r), err_type(r))
    r = run.get(C + "/namespaces/e_43/tables/t/credentials")
    R.check("C5", "run token cannot get storage credentials for e_43.t", refused(r), err_type(r))
    r = run.post(C + "/tables/rename", {"source": {"namespace": ["e_43"], "name": "t"},
                                        "destination": {"namespace": ["e_42"], "name": "moved"}})
    R.check("C6", "run token cannot rename e_43.t into e_42", refused(r), err_type(r))
    r = run.get(C + "/namespaces")
    listed = r.json().get("namespaces") if r.ok else None
    R.check("C7", "listing namespaces with the run token shows e_42 and not e_43",
            r.status_code == 200 and listed == [["e_42"]], "%s %s" % (err_type(r), listed))
    r43, r99 = run.get(C + "/namespaces/e_43"), run.get(C + "/namespaces/e_99_never_created")
    h43 = run.head(C + "/namespaces/e_43")
    same = (r43.status_code == r99.status_code and
            r43.json().get("error", {}).get("type") == r99.json().get("error", {}).get("type"))
    R.check("C8", "e_43 looks exactly like a namespace that does not exist", same and h43.status_code == 404,
            "GET e_43 %s, GET e_99 %s, HEAD e_43 %d" % (err_type(r43), err_type(r99), h43.status_code))
    r = run.post(C + "/namespaces", {"namespace": ["e_44_by_run"]})
    R.check("C9", "run token cannot create a namespace outside e_42", refused(r), err_type(r))
    for cid, label, loc in (("C10a", "e_43.t's folder", ids["e_43"]["loc"]),
                            ("C10b", "e_43's namespace folder (it holds e_43.t)", ids["e_43"]["loc"].rsplit("/", 1)[0]),
                            ("C10c", "the warehouse root", "s3://%s/%s" % (BUCKET, KEY_PREFIX))):
        r = run.post(C + "/namespaces/e_42/tables", {"name": "located", "schema": ICEBERG_SCHEMA, "location": loc})
        R.check(cid, "run cannot create an e_42 table located at %s" % label, r.status_code in (400, 403, 409),
                err_type(r))
        if r.ok:
            run.delete(C + "/namespaces/e_42/tables/located?purgeRequested=false")
    r = run.post(C + "/namespaces/e_42/register", {"name": "registered", "metadata-location": ids["e_43"]["meta"]})
    R.check("C11", "run cannot register e_43.t's metadata file as a table in e_42", r.status_code in (400, 403, 404, 409),
            err_type(r))
    r = run.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_43"]["ns"],
                 {"writes": [{"type": "modify", "user": RUN_USER}]})
    ra = run.get("/management/v1/permissions/namespace/%s/assignments" % ids["e_43"]["ns"])
    R.check("C12", "run token cannot grant itself access to e_43 or read e_43's grants", refused(r) and refused(ra),
            "grant %s, read grants %s" % (err_type(r), err_type(ra)))
    r = run.delete(C + "/namespaces/e_43/tables/t")
    R.check("C13", "run token cannot drop e_43.t", refused(r), err_type(r))

    # ------------------------------------------------------------------ D: vended storage credentials
    r = run.get(C + "/namespaces/e_42/tables/t", headers=VENDED)
    lr42 = r.json()
    pre = vended(lr42)
    s3 = s3_for(pre)
    k42, k43 = key_of(ids["e_42"]["loc"]), key_of(ids["e_43"]["loc"])
    k43_ns = k43.rsplit("/", 1)[0]
    k_out = key_of(out.location())
    k43_meta = key_of(ids["e_43"]["meta"])
    probe = k42 + "/data/probe-run-42.txt"
    put = s3_try(lambda: s3.put_object(Bucket=BUCKET, Key=probe, Body=b"run-42"))
    get = s3_try(lambda: s3.get_object(Bucket=BUCKET, Key=probe)["Body"].read())
    lst = s3_try(lambda: s3.list_objects_v2(Bucket=BUCKET, Prefix=k42 + "/"))
    R.check("D1", "e_42.t credentials write, read and list e_42.t's folder",
            put == get == lst == "ALLOWED", "put %s, get %s, list-own-prefix %s" % (put, get, lst))
    g43 = s3_try(lambda: s3.get_object(Bucket=BUCKET, Key=k43_meta)["Body"].read())
    p43 = s3_try(lambda: s3.put_object(Bucket=BUCKET, Key=k43 + "/data/intruder.txt", Body=b"x"))
    R.check("D2", "e_42.t credentials are refused on e_43.t's folder", g43.startswith("DENIED") and p43.startswith("DENIED"),
            "get metadata %s, put %s" % (g43, p43))
    pn = s3_try(lambda: s3.put_object(Bucket=BUCKET, Key=k43_ns + "/intruder.txt", Body=b"x"))
    R.check("D3", "e_42.t credentials are refused on e_43's namespace folder", pn.startswith("DENIED"), pn)
    lb = s3_try(lambda: s3.list_objects_v2(Bucket=BUCKET))
    lw = s3_try(lambda: s3.list_objects_v2(Bucket=BUCKET, Prefix=KEY_PREFIX + "/"))
    l43 = s3_try(lambda: s3.list_objects_v2(Bucket=BUCKET, Prefix=k43 + "/"))
    lbs = s3_try(lambda: s3.list_buckets())
    R.check("D4", "e_42.t credentials cannot list the bucket, the warehouse prefix, e_43's folder or the buckets",
            all(x.startswith("DENIED") for x in (lb, lw, l43, lbs)),
            "bucket %s, wh/ %s, e_43.t/ %s, ListBuckets %s" % (lb, lw, l43, lbs))
    ps = s3_try(lambda: s3.put_object(Bucket=BUCKET, Key=k_out + "/data/intruder.txt", Body=b"x"))
    R.check("D5", "e_42.t credentials are refused on a sibling table (e_42.run_out): scope is one table", ps.startswith("DENIED"), ps)
    claims = sts_claims(pre["s3.session-token"])
    res = []
    for st in (claims or {}).get("policy", {}).get("Statement", []):
        res += st.get("Resource", []) if isinstance(st.get("Resource"), list) else [st.get("Resource")]
    meta["sts_session_policy"] = claims.get("policy") if claims else None
    scoped = bool(res) and all(("/%s/" % k42) in x or x.endswith("/" + k42) or x == "arn:aws:s3:::" + BUCKET for x in res)
    R.check("D6", "the STS session policy Lakekeeper requested names only e_42.t's prefix",
            scoped, "parent=%s resources=%s" % (claims and claims.get("parent"), [r_.replace(k42, "{e_42.t}") for r_ in res]))
    exp_ms = int(pre.get("s3.session-token-expires-at-ms", 0) or 0)
    lifetime_left = claims["exp"] - time.time() if claims and claims.get("exp") else None
    R.note("vended credential lifetime", "session token exp in %ss, Lakekeeper's s3.session-token-expires-at-ms in %ss "
           "(warehouse sts-token-validity-seconds=%d)" % (
               None if lifetime_left is None else int(lifetime_left),
               int(exp_ms / 1000 - time.time()) if exp_ms else None, sts_validity))
    meta["pre_revocation_creds_exp"] = claims.get("exp") if claims else None

    # ------------------------------------------------------------------ G: re-granting
    r = run.post("/management/v1/permissions/warehouse/%s/table/%s/assignments" % (wid, out_id),
                 {"writes": [{"type": "select", "user": "oidc~run-43"}]})
    shared = r.status_code == 204
    r43tok = mint("run-43", exp_in=600)["token"]
    run43 = Lake(r43tok, "run-43", log)
    r43load = run43.get(C + "/namespaces/e_42/tables/run_out", headers=VENDED)
    R.check("L1", "limit: without managed access, the run can share a table it created with another run",
            shared and r43load.status_code == 200,
            "run-42 grants select on e_42.run_out to run-43: %s; run-43 loads it: %s" % (err_type(r), err_type(r43load)))
    if shared:
        dash.post("/management/v1/permissions/warehouse/%s/table/%s/assignments" % (wid, out_id),
                  {"deletes": [{"type": "select", "user": "oidc~run-43"}]})
    r = dash.post("/management/v1/permissions/warehouse/%s/managed-access" % wid, {"managed-access": True})
    R.step("Dashboard turns on managed access for the warehouse", r.status_code in (200, 204), err_type(r))
    r = run.post("/management/v1/permissions/warehouse/%s/table/%s/assignments" % (wid, out_id),
                 {"writes": [{"type": "select", "user": "oidc~run-43"}]})
    r43load = run43.get(C + "/namespaces/e_42/tables/run_out", headers=VENDED)
    R.check("G1", "with managed access on, the run cannot share its tables",
            refused(r) and refused(r43load), "grant: %s; run-43 load: %s" % (err_type(r), err_type(r43load)))

    # ------------------------------------------------------------------ A: tokens Lakekeeper must refuse
    def cfg_status(**kw):
        tok = mint(RUN, **kw)["token"]
        import requests
        return requests.get(LK + "/catalog/v1/config", params={"warehouse": WAREHOUSE},
                            headers={"Authorization": "Bearer " + tok}, timeout=15).status_code

    base = cfg_status(exp_in=600)
    R.check("A0", "control: a fresh run token reaches the catalog", base == 200, str(base))
    for cid, label, kw in (
            ("A1", "an expired run token (exp 120 s ago) is refused", {"exp_in": -120}),
            ("A2", "a token signed by a different key under the published kid is refused", {"key": "rogue"}),
            ("A3", "a token signed by a different key under an unknown kid is refused", {"key": "rogue", "kid": "not-published"}),
            ("A4", "an unsigned token (alg none) is refused", {"alg": "none"}),
            ("A5", "an HS256 token keyed with the public key (algorithm confusion) is refused", {"alg": "HS256"}),
            ("A6", "a token for another audience is refused", {"aud": "some-other-service"}),
            ("A7", "a token from another issuer is refused", {"iss": "http://evil.example"}),
            ("A8", "a token without exp is refused", {"omit": ["exp"]}),
            ("A9", "a token without a kid header is refused", {"kid": None})):
        code = cfg_status(**kw)
        R.check(cid, label, code == 401, str(code))
    leeway = {d: cfg_status(exp_in=-d) for d in (10, 50, 70, 90)}
    R.check("L2", "limit: Lakekeeper still accepts a token up to about 60 s after its exp (clock leeway)",
            leeway[10] == 200 and leeway[50] == 200 and leeway[70] == 401 and leeway[90] == 401,
            ", ".join("exp %ds ago -> %d" % (d, c) for d, c in leeway.items()))
    lax = {"no aud claim": cfg_status(omit=["aud"]), "no iss claim": cfg_status(omit=["iss"]),
           "nbf 10 min ahead": cfg_status(nbf_in=600), "no iat": cfg_status(omit=["iat"])}
    R.check("L3", "limit: a token with no aud or no iss claim is accepted, and nbf is not checked",
            all(c == 200 for c in lax.values()), ", ".join("%s -> %d" % kv for kv in lax.items()))

    # ------------------------------------------------------------------ S: remote signing (before revocation)
    rs42 = run.get(C + "/namespaces/e_42/tables/t", headers=SIGNING).json()
    k42_meta = key_of(rs42["metadata-location"])
    sr, signed = remote_sign(run, rs42, "GET", k42_meta)
    got = send_signed(signed, "GET").status_code if signed else None
    R.check("S1", "remote signing: Lakekeeper signs a read of e_42.t's metadata and RustFS serves it",
            sr.status_code == 200 and got == 200, "sign %s, GET %s" % (err_type(sr), got))
    sr43, _ = remote_sign(run, rs42, "GET", k43_meta)
    gen43 = run.post(C + "/v1/aws/s3/sign", {"region": REGION, "method": "GET",
                                            "uri": "http://%s/%s/%s" % (S3_IN_NET, BUCKET, k43_meta),
                                            "headers": {"x-amz-content-sha256": ["UNSIGNED-PAYLOAD"]}})
    R.check("S2", "remote signing: Lakekeeper will not sign a read of e_43.t's files for the run",
            sr43.status_code in (400, 403, 404) and gen43.status_code in (400, 403, 404),
            "via e_42.t's signer endpoint %s, via the warehouse signer endpoint %s" % (err_type(sr43), err_type(gen43)))
    rs_out = run.get(C + "/namespaces/e_42/tables/run_out", headers=SIGNING).json()

    # ------------------------------------------------------------------ E: revocation 1, remove the grant
    pre_out = vended(run.get(C + "/namespaces/e_42/tables/run_out", headers=VENDED).json())
    poll = Poller(run_tok, C + "/namespaces/e_42/tables/t")
    poll.start()
    time.sleep(0.5)
    revoke = {"deletes": grant["writes"]}
    c0 = time.time()
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_42"]["ns"], revoke)
    c1 = time.time()
    first, delay, attempts = until_refused(lambda: run.get(C + "/namespaces/e_42/tables/t"))
    time.sleep(0.5)
    poll.stop.set()
    poll.join(5)
    win = revocation_window(poll.samples, c0, c1)
    win["delay_to_refusal_s"] = None if delay is None else round(delay, 3)
    meta["revoke_grant_window"] = win
    R.step("Dashboard removes run-42's grant on e_42", r.status_code == 204, "%s in %s" % (err_type(r), ms(c1 - c0)))
    R.check("E1", "right after the grant is removed, the same unexpired run token is refused on e_42.t",
            refused(first) and attempts == 1 and win["ok_started_after_call"] == 0,
            "revoke call %s; next request %s; concurrent poller: %d ok before the call, statuses during it %s, "
            "%d refused and %d ok among requests started after it" % (
                ms(c1 - c0), delay_text(first, delay, attempts), win["ok_before_call"],
                sorted(set(win["during_call"])), win["refused_started_after_call"], win["ok_started_after_call"]))
    r = run.post(C + "/namespaces/e_42/tables", {"name": "after_revoke", "schema": ICEBERG_SCHEMA})
    R.check("E2", "after the grant is removed, the run cannot create tables in e_42", refused(r), err_type(r))
    r = run.get(C + "/namespaces/e_42/tables/t/credentials")
    R.check("E3", "after the grant is removed, the run cannot fetch fresh credentials for e_42.t", refused(r), err_type(r))
    sr, _ = remote_sign(run, rs42, "GET", k42_meta)
    R.check("E4", "after the grant is removed, Lakekeeper stops signing requests for e_42.t", sr.status_code in (401, 403, 404),
            err_type(sr))
    lo = run.get(C + "/namespaces/e_42/tables/run_out")
    co = run.post(C + "/namespaces/e_42/tables/run_out", {"requirements": [], "updates": [
        {"action": "set-properties", "updates": {"after-grant-removal": "yes"}}]})
    lt = run.get(C + "/namespaces/e_42/tables")
    R.check("L4", "limit: after the grant is removed, the run still loads and commits the table it created (it owns it)",
            lo.status_code == 200 and co.status_code == 200,
            "load run_out %s, commit run_out %s, list e_42 %s %s" % (
                err_type(lo), err_type(co), err_type(lt),
                [i["name"] for i in lt.json().get("identifiers", [])] if lt.ok else ""))
    s3_pre = s3_for(pre)
    after_get = s3_try(lambda: s3_pre.get_object(Bucket=BUCKET, Key=probe)["Body"].read())
    after_put = s3_try(lambda: s3_pre.put_object(Bucket=BUCKET, Key=k42 + "/data/after-revoke.txt", Body=b"late"))
    left = claims["exp"] - time.time() if claims and claims.get("exp") else None
    R.check("L5", "limit: storage credentials vended before the revocation keep working after it (until they expire)",
            after_get == "ALLOWED" and after_put == "ALLOWED",
            "get %s, put %s; they expire in %ss" % (after_get, after_put, None if left is None else int(left)))

    # ------------------------------------------------------------------ E: revocation 2, delete the user
    c0 = time.time()
    r = dash.delete("/management/v1/user/%s" % RUN_USER)
    c1 = time.time()
    R.step("Dashboard deletes user oidc~run-42", r.status_code == 204, "%s in %s" % (err_type(r), ms(c1 - c0)))
    lo, delay, attempts = until_refused(lambda: run.get(C + "/namespaces/e_42/tables/run_out"))
    meta["delete_user_delay_to_refusal_s"] = None if delay is None else round(delay, 3)
    co = run.post(C + "/namespaces/e_42/tables/run_out", {"requirements": [], "updates": [
        {"action": "set-properties", "updates": {"after-user-deletion": "yes"}}]})
    lt = run.get(C + "/namespaces/e_42/tables")
    ln = run.get(C + "/namespaces")
    sr, _ = remote_sign(run, rs_out, "GET", key_of(rs_out["metadata-location"]))
    R.check("E5", "right after the user is deleted, the same token is refused on everything in e_42, its own tables included",
            refused(lo) and attempts == 1 and all(refused(x) for x in (co, lt, ln, sr)),
            "load run_out: %s; then commit %s, list e_42 %s, list namespaces %s, sign %s" % (
                delay_text(lo, delay, attempts), err_type(co), err_type(lt), err_type(ln), err_type(sr)))
    r = dash.get("/management/v1/permissions/warehouse/%s/table/%s/assignments" % (wid, out_id))
    R.check("E6", "deleting the user removed its ownership of e_42.run_out",
            r.status_code == 200 and not any(a.get("user") == RUN_USER for a in r.json().get("assignments", [])),
            "%s %s" % (err_type(r), r.json().get("assignments") if r.ok else ""))
    s3_out = s3_for(pre_out)
    late = s3_try(lambda: s3_out.put_object(Bucket=BUCKET, Key=k_out + "/data/after-user-deletion.txt", Body=b"late"))
    R.note("credentials vended for e_42.run_out before the user deletion", "put after deletion: %s" % late)

    # ------------------------------------------------------------------ E: user deletion alone (run-44)
    make_execution_namespace("e_44")
    g44 = {"writes": [{"type": "create", "user": "oidc~run-44"}, {"type": "modify", "user": "oidc~run-44"}]}
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_44"]["ns"], g44)
    R.step("grant oidc~run-44 on e_44 without provisioning the user", r.status_code == 204, err_type(r))
    tok44 = mint("run-44", exp_in=3600)["token"]
    run44 = Lake(tok44, "run-44", log)
    cat44 = catalog(tok44, "run-44-iceberg", log)
    n = rows(host_io(cat44.load_table("e_44.t")))
    R.check("B6", "a run granted before Lakekeeper ever saw it reads its namespace (no provisioning needed)", n == 2,
            "rows=%d" % n)
    c0 = time.time()
    r = dash.delete("/management/v1/user/oidc~run-44")
    c1 = time.time()
    l44, delay, attempts = until_refused(lambda: run44.get(C + "/namespaces/e_44/tables/t"))
    k44 = run44.post(C + "/namespaces/e_44/tables", {"name": "after", "schema": ICEBERG_SCHEMA})
    a44 = dash.get("/management/v1/permissions/namespace/%s/assignments" % ids["e_44"]["ns"])
    left44 = [a for a in a44.json().get("assignments", []) if a.get("user") == "oidc~run-44"] if a44.ok else None
    R.check("E7", "deleting the user alone also removes its namespace grant; the same token is refused at once",
            r.status_code == 204 and refused(l44) and attempts == 1 and refused(k44) and left44 == [],
            "delete %s in %s; load e_44.t: %s; create %s; grants left %s" % (
                err_type(r), ms(c1 - c0), delay_text(l44, delay, attempts), err_type(k44), left44))
    # A grant for an identity that never called Lakekeeper: is there a user to delete?
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_44"]["ns"],
                  {"writes": [{"type": "select", "user": "oidc~run-46"}]})
    d46 = dash.delete("/management/v1/user/oidc~run-46")
    a46 = dash.get("/management/v1/permissions/namespace/%s/assignments" % ids["e_44"]["ns"])
    left46 = [a for a in a46.json().get("assignments", []) if a.get("user") == "oidc~run-46"] if a46.ok else None
    R.check("L6", "limit: deleting a user Lakekeeper never saw does not remove its grants (revoke must delete them explicitly)",
            bool(left46), "grant %s; delete user %s; grants left %s" % (err_type(r), err_type(d46), left46))
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_44"]["ns"],
                  {"deletes": [{"type": "select", "user": "oidc~run-46"}]})
    R.note("explicit grant removal for the never-seen user", err_type(r))

    # ------------------------------------------------------------------ P: a narrower grant, create + select
    narrow = {"writes": [{"type": "create", "user": "oidc~run-48"}, {"type": "select", "user": "oidc~run-48"}]}
    r = dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_42"]["ns"], narrow)
    R.step("grant oidc~run-48 'create' + 'select' on e_42 (the narrower alternative)", r.status_code == 204, err_type(r))
    tok48 = mint("run-48", exp_in=600)["token"]
    run48 = Lake(tok48, "run-48", log)
    cat48 = catalog(tok48, "run-48-iceberg", log)
    n_t = rows(host_io(cat48.load_table("e_42.t")))
    own = host_io(cat48.create_table("e_42.r48", schema=SCHEMA))
    own.append(pa.table({"id": [1], "v": ["by-run-48"]}, schema=SCHEMA))
    n_own = rows(host_io(cat48.load_table("e_42.r48")))
    R.check("P1", "with 'create' + 'select', a run reads the namespace and writes the tables it creates",
            n_t == 3 and n_own == 1, "rows e_42.t=%d, e_42.r48=%d" % (n_t, n_own))
    c48 = run48.post(C + "/namespaces/e_42/tables/t", {"requirements": [], "updates": [
        {"action": "set-properties", "updates": {"by": "run-48"}}]})
    d48 = run48.delete(C + "/namespaces/e_42/tables/t")
    R.check("P2", "with 'create' + 'select', the run cannot change or drop a table it did not create",
            refused(c48) and refused(d48), "commit e_42.t %s, drop e_42.t %s" % (err_type(c48), err_type(d48)))
    cr48 = vended(run48.get(C + "/namespaces/e_42/tables/t", headers=VENDED).json())
    s48 = s3_for(cr48)
    g48 = s3_try(lambda: s48.get_object(Bucket=BUCKET, Key=k42_meta)["Body"].read())
    w48 = s3_try(lambda: s48.put_object(Bucket=BUCKET, Key=k42 + "/data/by-run-48.txt", Body=b"x"))
    acts = sorted({a for st in (sts_claims(cr48["s3.session-token"]) or {}).get("policy", {}).get("Statement", [])
                   for a in (st.get("Action") if isinstance(st.get("Action"), list) else [st.get("Action")])})
    R.check("P3", "for a table the run may only read, Lakekeeper vends read-only storage credentials",
            g48 == "ALLOWED" and w48.startswith("DENIED"), "get %s, put %s, policy actions %s" % (g48, w48, acts))
    dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_42"]["ns"], {"deletes": narrow["writes"]})
    dash.delete("/management/v1/user/oidc~run-48")

    # ------------------------------------------------------------------ empty-namespace squatting
    rr = dash.post(C + "/namespaces", {"namespace": ["e_45"]})
    ns45 = rr.json()["properties"]
    log.name(ns45["namespace_id"], "{e_45_id}")
    tok47 = mint("run-47", exp_in=600)["token"]
    run47 = Lake(tok47, "run-47", log)
    dash.post("/management/v1/permissions/namespace/%s/assignments" % ids["e_42"]["ns"],
              {"writes": [{"type": "create", "user": "oidc~run-47"}]})
    sq = run47.post(C + "/namespaces/e_42/tables", {"name": "squat", "schema": ICEBERG_SCHEMA, "location": ns45["location"]})
    t45 = dash.post(C + "/namespaces/e_45/tables", {"name": "t", "schema": ICEBERG_SCHEMA})
    R.check("L7", "limit: a run that knows an empty namespace's location can claim it with a custom table location; "
            "that namespace then cannot create tables",
            sq.status_code == 200 and t45.status_code == 409,
            "run creates e_42.squat at e_45's folder: %s; Dashboard creates e_45.t: %s" % (err_type(sq), err_type(t45)))

    # ------------------------------------------------------------------ STS lifetime bounds
    def lifetime_for(name, validity):
        rr = dash.post("/management/v1/warehouse", {"warehouse-name": name, "storage-profile": dict(
            s3_profile(validity), **{"key-prefix": name}), "storage-credential": s3_cred})
        if rr.status_code != 201:
            return err_type(rr), None, None
        w = rr.json()["warehouse-id"]
        dash.post("/catalog/v1/%s/namespaces" % w, {"namespace": ["n"]})
        tt = dash.post("/catalog/v1/%s/namespaces/n/tables" % w, {"name": "t", "schema": ICEBERG_SCHEMA}, headers=VENDED)
        cr = vended(tt.json()) if tt.ok else None
        if not cr:
            return err_type(tt), None, None
        cl = sts_claims(cr["s3.session-token"])
        lk_ms = int(cr.get("s3.session-token-expires-at-ms", 0) or 0)
        return "201", int(cl["exp"] - time.time()), (int(lk_ms / 1000 - time.time()) if lk_ms else None)

    life = {v: lifetime_for("lake-ttl-%s" % ("default" if v is None else v), v) for v in (None, 60, 900, 43200, 86400)}
    meta["sts_lifetimes"] = {str(k): v for k, v in life.items()}
    for v, (code, actual, said) in life.items():
        R.note("STS lifetime for sts-token-validity-seconds=%s" % ("unset" if v is None else v),
               "warehouse create %s, credentials really expire in %ss, Lakekeeper tells the client %ss" % (code, actual, said))
    c60 = life[60]
    R.check("L8", "limit: vended credentials cannot be shorter than 900 s on RustFS (asking for 60 s gives 900 s)",
            c60[1] is not None and 850 <= c60[1] <= 900, "asked 60 s, got %ss" % c60[1])

    # ------------------------------------------------------------------ I: the least an issuer must serve
    import requests
    who = lambda tok, base=LK: requests.get(base + "/management/v1/whoami",  # noqa: E731
                                            headers={"Authorization": "Bearer " + tok}, timeout=15).status_code
    min_ok = who(mint(DASHBOARD_SUB, iss="http://sce0tok-issuer:8080/minimal", exp_in=600)["token"], LK_MIN)
    min_other = who(mint(DASHBOARD_SUB, exp_in=600)["token"], LK_MIN)
    R.check("I1", "a Lakekeeper whose issuer's discovery document holds only issuer + jwks_uri accepts that issuer's "
            "tokens, and refuses tokens naming the other issuer",
            min_ok == 200 and min_other == 401, "iss=/minimal -> %d, iss=root issuer -> %d" % (min_ok, min_other))
    code, secs, why = start_lakekeeper_without_issuer()
    R.check("L10", "limit: Lakekeeper does not start when the issuer's discovery URL cannot be reached",
            code not in (None, 0) and "openid configuration" in why.lower(),
            "exit code %s after %ss: %s" % (code, secs, why))

    # ------------------------------------------------------------------ K: issuer key rotation
    old = mint(DASHBOARD_SUB, exp_in=600)
    rotate("add")
    new = mint(DASHBOARD_SUB, exp_in=600)
    a_new, a_old = who(new["token"]), who(old["token"])
    R.check("K1", "after the issuer adds a new key, tokens signed with it are accepted at once and old ones still work",
            a_new == 200 and a_old == 200, "new kid -> %d, old kid -> %d" % (a_new, a_old))
    rotate("retire-old")
    still = who(old["token"])
    R.check("L9", "limit: a key the issuer stopped publishing is still trusted until Lakekeeper refetches the JWKS",
            still == 200, "old-kid token right after retirement -> %d" % still)
    trigger = who(mint(DASHBOARD_SUB, key="rogue", kid="unknown-kid-to-force-refetch", exp_in=600)["token"])
    gone = who(old["token"])
    fresh = who(mint(DASHBOARD_SUB, exp_in=600)["token"])
    R.check("K2", "once Lakekeeper refetches the JWKS (any unknown kid triggers it), the retired key is refused",
            gone == 401 and fresh == 200, "unknown-kid token %d, then old-kid token %d, current-kid token %d" % (
                trigger, gone, fresh))

    # ------------------------------------------------------------------ X: long waits (SCE0TOK_WAIT_STS_EXPIRY=1)
    if long_mode and claims and claims.get("exp"):
        # JWKS cache: retire a key Lakekeeper has cached, then never show it an unknown kid
        # while we wait, and see whether it ever refetches the JWKS on its own.
        cached_old = mint(DASHBOARD_SUB, exp_in=7200)["token"]
        rotate("add")
        who(mint(DASHBOARD_SUB, exp_in=7200)["token"])  # unknown kid -> Lakekeeper refetches: both keys cached
        rotate("retire-old")
        j0 = time.time()
        jwks_last_ok, jwks_first_refused = None, None
        exp = claims["exp"]
        R.note("waiting for the pre-revocation credentials to expire", "in %ds" % int(exp - time.time()))
        stop_at, status = None, None
        next_jwks = 0
        while time.time() < exp + 300:
            status = s3_try(lambda: s3_pre.get_object(Bucket=BUCKET, Key=probe)["Body"].read())
            if status.startswith("DENIED"):
                stop_at = time.time()
                break
            if time.time() >= next_jwks and jwks_first_refused is None:
                code = who(cached_old)
                if code == 200:
                    jwks_last_ok = time.time() - j0
                else:
                    jwks_first_refused = time.time() - j0
                next_jwks = time.time() + 30
            time.sleep(10 if exp - time.time() > 60 else 2)
        R.check("X1", "the credentials vended before the revocation stop working when they expire",
                stop_at is not None and abs(stop_at - exp) <= 60,
                "%s at exp%+ds" % (status, int((stop_at or time.time()) - exp)))
        R.check("X2", "limit: with no unknown kid to trigger a refetch, Lakekeeper kept trusting a retired key "
                "for the whole wait", jwks_first_refused is None and jwks_last_ok is not None,
                "retired-key token still accepted %ss after retirement%s" % (
                    None if jwks_last_ok is None else int(jwks_last_ok),
                    "" if jwks_first_refused is None else ", refused from %ds" % int(jwks_first_refused)))

    # ------------------------------------------------------------------ I2: the issuer goes away (last: stops it)
    import subprocess
    known = mint(DASHBOARD_SUB, exp_in=600)["token"]
    unknown = mint(DASHBOARD_SUB, key="rogue", kid="kid-seen-while-issuer-down", exp_in=600)["token"]
    subprocess.run(["docker", "stop", "-t", "1", "sce0tok-issuer"], capture_output=True)
    k_code, u_code = who(known), who(unknown)
    R.check("I2", "with the issuer stopped, a running Lakekeeper still accepts tokens signed with a cached key",
            k_code == 200 and u_code == 401, "cached kid -> %d, unknown kid -> %d" % (k_code, u_code))


if __name__ == "__main__":
    sys.exit(main())
