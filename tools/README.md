# tools

Scripts that drove the verification runs of steps 2 and 3. They lived in a session's scratch
directory and were moved here at the handover; the paths that were specific to that session are
now settings.

| Setting | Default | What it is |
|---|---|---|
| `SCE_WORKTREES` | `$HOME/Desktop/projects/texera-worktrees` | where the Texera worktrees and this harness are |
| `SCE_WORK` | `$HOME/.sce-work` | summaries and logs the scripts write |
| `SCE_LOCK` | `$SCE_WORK/stack.lock` | the lock every job that brings a stack up takes (a directory; `mkdir` takes it, `rm -rf` lets it go) |
| `UDF_PYTHON_PATH` | `$SCE_WORK/py311/bin/python` | a Python 3.11 with amber's requirements, for the integration suite |

Make the Python once from a Texera checkout:

```bash
uv venv --python 3.11 "$HOME/.sce-work/py311"
uv pip install --python "$HOME/.sce-work/py311/bin/python" \
  -r amber/requirements.txt -r amber/operator-requirements.txt
```

The Scala suites need a Postgres on `127.0.0.1:5432` (user and password `postgres`) with Texera's
schema, as `docs/step3-design.md` section 13 says:

```bash
docker run -d --name texera-tripwire-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 groonga/pgroonga:4.0.1-debian-15
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_ddl.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/iceberg_postgres_catalog.sql
docker exec -i texera-tripwire-pg psql -q -U postgres < sql/texera_lakefs.sql
```

| Script | Does |
|---|---|
| `suite.sh <worktree> <tag> [catalog-db]` | every Scala suite of a worktree, one after another (about 15 minutes); one line per suite in `$SCE_WORK/suite-<tag>.summary`. A catalog database of its own keeps two worktrees' runs apart |
| `live-result-service.sh <dist-zip> <worktree> [scenario]` | on the running `sce` stack: runs the result service's dist in a container with the Dashboard's settings, runs one scenario (default a), and reads its execution through the service before the stack's retention expires its results: the rows the Dashboard recorded, the latest finished execution, the results, a first page and the statistics of each |
| `frontend-check.sh <worktree> <tag>` | the frontend's unit tests, `yarn format:ci` and `yarn build:ci` (Node 24 through nvm) |
| `gate.sh <commit> <tag> <driver args>` | builds the images of a commit (with the frontend) in the `sce-imgbuild` worktree, then runs single-node, the browser smoke, Kubernetes and local-dev in turn; a summary in `reports/gate-<tag>.summary`. `SN_STACK_OPTS="--isolate-unit"` for the evidence checks; `K8S_SCN` and `LD_SCN` pick the scenarios of the two other modes. It needs the detached worktrees `sce-imgbuild` and `sce-localdev-src` and OrbStack's Kubernetes |
| `step3/rest-check.sh <suites...>` | runs amber suites against a real REST catalog (the step 0 proof's Lakekeeper on RustFS), under the lock. Prepared for step 3's sub-part 5 and never run |
| `step3/mutate-batch.py`, `step3/mut-web.py` | 20 hand-made breaks of `transitionTo` and its call sites, and a runner that applies a batch and reports which specs fail. Prepared for sub-part 5 and never run |
| `step3/patch_rest.py` | a throwaway patch that points the storage specs of sub-parts 2-4 at the configured catalog, so they can run against Lakekeeper; never to be committed to Texera |

The command that verified the end of step 2 on the main branch:

```bash
SN_STACK_OPTS="--isolate-unit" \
K8S_SCN="a,b,c,d,e,u,k,l1,l6,l8,m,o,f,f2,g,h,i" \
LD_SCN="a,b,c,d,e,u,j,k,l,m,o,f,f2,g,h,i" \
  tools/gate.sh 3d84565a5 step3p5 --gate D
```
