<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# `bin/`

This directory holds the scripts, Dockerfiles, and configuration used to
develop, build, and test Texera. Most scripts expect to be run **from the
`texera` project root** (the parent of this directory).

## Local development

| Entry point | Purpose |
| --- | --- |
| `texera-2-0/up.sh` | Brings the Texera 2.0 dev stack up: infrastructure containers, then the catalog, the computing unit, the agent runtime and the frontend on the host. See [`texera-2-0/`](texera-2-0/README.md). |
| `texera-2-0/test.sh` | Runs the unit and integration suites and the end-to-end checks. |
| `texera-2-0/down.sh` | Stops the stack (`--wipe` also deletes its volumes). |

The 1.x deployments (the single-node Docker Compose stack and the Helm chart)
are not part of this branch; a 2.0 deployment will be built on the dev stack's
services.

## Docker images

`dockerfiles/` holds the computing unit images (`computing-unit-master.dockerfile`
and `computing-unit-worker.dockerfile`). Build them with the project root as the
Docker build context:

```bash
docker build -f bin/dockerfiles/computing-unit-master.dockerfile -t your-repo/computing-unit-master:test .
```

### Reproducible builds

Built from the same commit with the same builder, an image comes out byte for
byte the same. Everything that would otherwise drift is pinned:

| Input | Pinned by |
| --- | --- |
| Base images | the digest in each `FROM` (Renovate refreshes them weekly) |
| apt and pip packages | `PACKAGE_SNAPSHOT`, a UTC date: [`dockerfiles/snapshot/install.sh`](dockerfiles/snapshot/install.sh) installs from snapshot.ubuntu.com / snapshot.debian.org and from PyPI as they stood at 00:00 that day |
| Timestamps (jars, dist zips, the frontend build number, `/etc/shadow`, layer mtimes) | `SOURCE_DATE_EPOCH`, the commit time |
| BuildKit | `moby/buildkit:v0.33.1`, set in `.github/workflows/build-and-push-images.yml`; other versions can produce different digests |

`build-images.sh` and the image workflow pass both. To rebuild one image by
hand (after generating the jOOQ sources with `sbt DAO/jooqGenerate`):

```bash
docker buildx create --name texera-repro --driver docker-container \
  --driver-opt image=moby/buildkit:v0.33.1 --use
export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
docker buildx build --platform linux/amd64 \
  --build-arg SOURCE_DATE_EPOCH --build-arg PACKAGE_SNAPSHOT=$(date -u -d @$SOURCE_DATE_EPOCH +%F) \
  --output type=oci,dest=computing-unit-master.tar,rewrite-timestamp=true \
  -f bin/dockerfiles/computing-unit-master.dockerfile .
```

| Script | Purpose |
| --- | --- |
| `build-images.sh` | Convenience wrapper to build (and push) platform-dependent images. Run `bin/build-images.sh --help`. |
| `merge-image-tags.sh` | Merge per-platform image tags into a single multi-arch manifest. |

Prebuilt images published by the Texera team are on the
[Texera DockerHub repository](https://hub.docker.com/repositories/texera).

## Code generation & formatting

| Script | Purpose |
| --- | --- |
| `python-proto-gen.sh` | Generate the Python code from protobuf definitions. |
| `fix-format.sh` | Run the repository's code formatters. |
| `protoc-version.txt` | Pins the `protoc` version used by the proto-gen scripts. |

## Benchmarks

| Script | Purpose |
| --- | --- |
| `run-benchmarks.sh` | Single entry point for all Texera benchmarks; CI calls this script verbatim. |

## Licensing

`licensing/` contains the scripts that audit JAR licenses and generate the
binary `NOTICE`/`LICENSE` files (`audit_jar_licenses.py`,
`check_binary_deps.py`, `concat_license_binary.py`,
`generate_notice_binary.py`) plus their unit tests.

## Other components & configuration

| Path | Purpose |
| --- | --- |
| `utils/` | Shared shell helpers (`resolve-texera-home.sh`, `texera-logging.sh`) sourced by other scripts. |
| `observability/` | An OpenTelemetry collector with Grafana, Loki and Parca for local tracing, logs and profiles. |
