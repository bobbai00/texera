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

# Step 0: timed commits and tidying with the Java Iceberg client

**Claim checked:** "With the Java Iceberg client, committing on a timer and tidying the tables keep
a day-long run fast to read."

## Answer

**Partly.** Committing on a timer and tidying keep **commits flat**. They do **not** keep a
whole-day read "well under 1 s" through Texera's reader, because that reader's cost is per row as
well as per file, and tidying only removes the per-file part.

- **Commits stay flat when tidied. PASS in every run.** Through Texera's own writer a timed
  commit costs about 100-120 ms p50 and 115-205 ms p95 all day (runs 2 and 3; up to 139 and
  250 ms in run 1). Tidying every 200 or every 50 commits makes no difference to that. Without
  tidying it climbs 2.3-3x by the end of the day (p50 96-120 ms to 277-291 ms) as the table
  metadata grows to 2.2 MB of JSON.
- **Reading the whole day does not stay well under 1 s. FAIL in every run.** After the end-of-run
  tidy (one file, 28,800 rows) Texera's reader takes 0.47-0.53 s. During the day, tidying every
  200 commits gives 0.23-1.95 s at checkpoints and a median of 0.8-1.0 s right before each tidy
  (up to 1.2-2.3 s, and once 4.9 s in run 1). Tidying every 50 commits gives a median of 0.46-0.55 s before each tidy, but
  it still passes 1 s late in the day and on noisy readings (up to 0.95-1.7 s before a tidy, up to
  1.1-2.9 s at checkpoints).
- **The cost is per file and per row.** A read costs about 3.5 ms per data file as raw records,
  4.6-5.9 ms through Texera (files are opened one after another, each with its own remote-signed
  GETs), plus 16-17 µs per row through Texera. Iceberg's own record reader reads the tidied day in
  **22-38 ms**. The per-row cost is Texera's conversion of records to `Tuple`s:
  `DocumentFactory`'s deserializer rebuilds the schema for every record.
- **Without tidying**, the full read takes 13.8-17.4 s at the end of the day (2,880 files). One
  tidy after the last commit takes 21.5-28.2 s and brings the read back to about 0.5 s.
- **The `log` table's newest row stays tiny** (at most 26-30 ms all day). Reading the whole log
  untidied is not tiny: 49 rows in 49 files take 272-346 ms. After the end-of-run tidy it takes
  10-15 ms.

The numbers come from two clean runs of the final program (`run-20261116T012927Z` and
`run-20261116T020528Z`), plus one earlier run with the first version (`run-20261116T010256Z`,
which had no `tidy-50` scenario and ran reads over 1.5 s only once). All three runs agree on
every check except one: `tidy-50`'s read right before a tidy stayed under 1 s in run 3 (946 ms)
but not in run 2 (1,706 ms).

## Results

### Checks

| check | run-20261116T010256Z | run-20261116T012927Z | run-20261116T020528Z |
|---|---|---|---|
| lake_up | PASS | PASS | PASS |
| benchmark_ran | PASS | PASS | PASS |
| no-tidy_rows_complete_ordered | PASS | PASS | PASS |
| tidy_rows_complete_ordered | PASS | PASS | PASS |
| tidy_read_all_end_under_1s | PASS | PASS | PASS |
| tidy_read_all_every_checkpoint_under_1s | FAIL | FAIL | FAIL |
| tidy_read_all_worst_case_under_1s | FAIL | FAIL | FAIL |
| tidy_commit_latency_flat | PASS | PASS | PASS |
| log_newest_row_tiny | PASS | PASS | PASS |
| log_read_all_tiny_untidied | FAIL | FAIL | FAIL |
| log_read_all_tiny_after_final_tidy | PASS | PASS | PASS |
| teardown_clean | PASS | PASS | PASS |
| tidy-50_rows_complete_ordered | - | PASS | PASS |
| tidy-50_read_all_end_under_1s | - | PASS | PASS |
| tidy-50_read_all_every_checkpoint_under_1s | - | FAIL | FAIL |
| tidy-50_read_all_worst_case_under_1s | - | FAIL | PASS |
| tidy-50_commit_latency_flat | - | PASS | PASS |

The FAILs are real results, not harness problems: every run brought the lake up, ran to the end,
kept every row in order through every tidy, and tore down cleanly.

### Key numbers, run by run

| measure | run-20261116T010256Z | run-20261116T012927Z | run-20261116T020528Z |
|---|---|---|---|
| tidy: commit p50, first -> last window (ms) | 119 -> 119 | 102 -> 108 | 105 -> 117 |
| tidy: commit p95, first -> last window (ms) | 154 -> 199 | 147 -> 130 | 141 -> 143 |
| tidy: read all at checkpoints, min - max (ms) | 294 - 1,666 | 389 - 1,249 | 225 - 1,947 |
| tidy: read all right before a tidy, median / max (ms) | 1,044 / 4,860 | 899 / 2,271 | 821 / 1,213 |
| tidy: one tidy, median / max (ms) | 1,796 / 4,161 | 1,677 / 2,166 | 1,622 / 2,346 |
| tidy: whole day after the final tidy, Texera / raw / 3 columns (ms) | 486 / - / - | 491 / 24 / 226 | 468 / 22 / 234 |
| tidy: newest row at checkpoints, direct max / Texera max (ms) | 38 / 155 | 28 / 170 | 25 / 168 |
| no-tidy: commit p50, first -> last window (ms) | 96 -> 291 | 104 -> 277 | 120 -> 277 |
| no-tidy: commit p95, first -> last window (ms) | 139 -> 426 | 144 -> 292 | 145 -> 292 |
| no-tidy: read all at checkpoints, min - max (ms) | 942 - 16,560 | 1,620 - 13,786 | 2,026 - 17,374 |
| no-tidy: loadTable, first -> last checkpoint (ms) | 4.3 -> 39.1 | 4.8 -> 46.5 | 5.6 -> 45.1 |
| no-tidy: catalog-only commit, first -> last checkpoint (ms) | 17.1 -> 107.7 | 19.3 -> 131.4 | 23.0 -> 115.3 |
| no-tidy: metadata JSON, first -> last checkpoint (KB) | 215 -> 2,243 | 215 -> 2,243 | 215 -> 2,243 |
| no-tidy: the one tidy at the end (ms) | 28,157 | 21,489 | 22,183 |
| no-tidy: whole day after the final tidy, Texera / raw / 3 columns (ms) | 497 / - / - | 486 / 25 / 234 | 480 / 26 / 234 |
| no-tidy: newest row at checkpoints, direct max / Texera max (ms) | 56 / 271 | 57 / 266 | 55 / 290 |
| log (tidy scenario): whole log at the end of the run, untidied (ms) | 272 (49 files) | 299 (49 files) | 346 (49 files) |
| log (tidy scenario): whole log after the final tidy (ms) | 15 | 13 | 10 |
| log (tidy scenario): newest row, direct max over the day (ms) | 30 | 26 | 29 |
| breakdown: commit through Texera's writer, p50 (ms) | 98.5 | 94.9 | 86.0 |
| breakdown: newAppend commit (manifest + list + REST commit), p50 (ms) | 81.4 | 83.3 | 72.2 |
| breakdown: newFastAppend commit, p50 (ms) | 43.6 | 49.5 | 48.1 |
| breakdown: newAppend commit with commit.manifest-merge.enabled=false, p50 (ms) | 72.0 | 73.2 | 68.1 |
| breakdown: catalog-only commit (property change), p50 (ms) | 12.9 | 16.7 | 13.3 |
| tidy-50: commit p50, first -> last window (ms) | - | 109 -> 106 | 107 -> 117 |
| tidy-50: commit p95, first -> last window (ms) | - | 170 -> 130 | 128 -> 131 |
| tidy-50: read all at checkpoints, min - max (ms) | - | 300 - 2,917 | 233 - 1,100 |
| tidy-50: read all right before a tidy, median / max (ms) | - | 551 / 1,706 | 464 / 946 |
| tidy-50: one tidy, median / max (ms) | - | 695 / 2,069 | 618 / 1,119 |
| tidy-50: whole day after the final tidy, Texera / raw / 3 columns (ms) | - | 492 / 26 / 276 | 529 / 38 / 278 |
| tidy-50: newest row at checkpoints, direct max / Texera max (ms) | - | 29 / 128 | 21 / 110 |

### One run in detail (`run-20261116T012927Z`)

Statistics table, tidied every 200 commits. Reads are medians of three. Raw records are the same
read without Texera's `Tuple` conversion; "3 columns" is Texera's `getRange` with a column list.

| commits | commit p50 / p95 ms | loadTable ms | metadata JSON KB | data files | snapshots | read all ms (raw / 3 columns) | newest row ms (Texera / direct) |
|---|---|---|---|---|---|---|---|
| 250 | 102 / 147 | 4.0 | 65 | 51 | 55 | 819 (638 / 763) | 102 / 28 |
| 1000 | 114 / 152 | 3.8 | 180 | 201 | 205 | 725 (725 / 639) | 68 / 23 |
| 1250 | 113 / 133 | 1.8 | 65 | 51 | 55 | 389 (171 / 268) | 90 / 9 |
| 2000 | 116 / 136 | 4.7 | 181 | 201 | 205 | 915 (633 / 917) | 68 / 23 |
| 2750 | 107 / 134 | 5.3 | 142 | 151 | 155 | 921 (574 / 771) | 119 / 18 |
| 2880, after the final tidy | - | 1.0 | 24 | 1 | 1 | 491 (24 / 226) | 37 / 26 |

The same table never tidied:

| commits | commit p50 / p95 ms | loadTable ms | catalog-only commit ms | metadata JSON KB (stored, gzip) | data files | read all ms (raw) | newest row ms (Texera / direct) |
|---|---|---|---|---|---|---|---|
| 250 | 104 / 144 | 4.8 | 19 | 215 (29) | 250 | 1,620 (1,901) | 141 / 46 |
| 1000 | 177 / 241 | 19.6 | 61 | 791 (108) | 1,000 | 3,548 (2,980) | 154 / 56 |
| 2000 | 232 / 316 | 49.0 | 133 | 1,563 (214) | 2,000 | 12,976 (9,562) | 244 / 42 |
| 2880 | 277 / 292 | 46.5 | 131 | 2,243 (308) | 2,880 | 13,786 (9,857) | 179 / 56 |
| 2880, after one 21.5 s tidy | - | 3.1 | 14 | 24 (3) | 1 | 486 (25) | 32 / 21 |

The full tables for every run, including `tidy-50` and every tidy, are in `raw/run-*/summary.txt`.
Every single commit is in `ticks.csv`.

### Why a tidied read still takes half a second

A full read through Texera's reader costs roughly **3.5-6 ms per data file + 16-17 µs per row**:

- **Per file.** Untidied, 2,880 files at the end of the day take 9.9-10.2 s as raw records
  (about 3.5 ms per file) and 13.8-17.4 s through Texera. The Java reader opens the files one
  after another, and each file costs its own remote-signed GET requests. Tidying removes this
  part.
- **Per row.** The same day compacted into one file takes 22-38 ms as raw records (about 1 µs a
  row) but 470-530 ms through Texera (16-17 µs a row). For every record, `DocumentFactory`'s
  deserializer calls `IcebergUtil.fromIcebergSchema(schema)` to rebuild the Amber schema and then
  builds a `Tuple`. `IcebergDocument.next()` also recomputes the projected schema for every row,
  which is why asking for 3 columns saves only about half. Tidying cannot remove this part. It
  grows with the run: at this rate a fully tidied table passes 1 s at about twice the rows (20
  operators for a day, or 10 for two days). That is an extrapolation, not a measurement.

### The log table (one row per state change, 49 in a day)

| run | state commit p50 / p95 ms | newest row, direct (max over the day) | newest row, Texera's getCount + getRange | whole log, untidied (49 files) | whole log after the final tidy |
|---|---|---|---|---|---|
| 20261116T010256Z | 111 / 207 | 30 ms | 133 ms | 272 ms | 15 ms |
| 20261116T012927Z | 102 / 120 | 26 ms | 115 ms | 299 ms | 13 ms |
| 20261116T020528Z | 100 / 120 | 29 ms | 113 ms | 346 ms | 10 ms |

Reading the state (the newest row) is cheap if done the direct way: `loadTable`, then the newest
snapshot's single added file. Texera's way (`getCount`, then `getRange`) plans the whole table
twice. The untidied whole-log read costs about 6-7 ms per file, so "tens of rows" means hundreds of
milliseconds. That is still small next to the statistics, but it is not tiny.

### Tidying cost

| | runs 2 and 3: one tidy, median (max) | made of |
|---|---|---|
| every 200 commits (201 files, up to 28,000 rows) | 1.6 s (2.3 s) | compaction about 0.8 s, snapshot expiry about 0.8 s, manifest rewrite about 75 ms |
| every 50 commits (51 files) | 0.64 s (2.1 s) | compaction about 0.35 s, expiry about 0.25 s |
| once, after an untidied day (2,880 files) | 21.5-22.2 s (28.2 s in run 1) | compaction 11-17 s (reading 2,880 files), expiry 9-11 s |
| the 49-row log at the end | 0.6-1.3 s | |

A day needs 14 tidies at 200 commits plus the final one (about 23 s of tidying in total), or 57
at 50 commits plus the final one (about 37 s). The benchmark ran each tidy inline, between two
ticks, on the thread that commits; tidying from a second thread while ticks continue was not
tested.

### Where a commit's time goes (scratch table, 40 of each, p50)

| step | run 2 | run 3 |
|---|---|---|
| a tick through Texera's writer: loadTable + write file + newAppend commit | 94.9 | 86.0 |
| loadTable | 1.6 | 1.6 |
| loadTable + first S3 request on the new table's FileIO | 3.8 | 3.5 |
| S3 HEAD on a held table's FileIO | 0.7 | 0.6 |
| held table: write one 10-row data file (Parquet + signed PUT) | 14.5 | 9.5 |
| held table: `newAppend` commit (merge append: manifest + manifest list + REST commit) | 83.3 | 72.2 |
| held table: write file + `newAppend` commit | 99.6 | 84.5 |
| held table: `newFastAppend` commit | 49.5 | 48.1 |
| held table: `newAppend` commit with `commit.manifest-merge.enabled=false` | 73.2 | 68.1 |
| held table: catalog-only commit (property change) | 16.7 | 13.3 |

Lakekeeper's own share of a commit (load the table, write a new `metadata.json`, update its
database) is the catalog-only commit, about 13-17 ms. Most of the rest is the client's merge-append
work and two more signed PUTs (manifest and manifest list). Re-resolving the table on every flush,
as `IcebergTableWriter` does since #7290, costs only about 4 ms.

### What a finished run leaves in storage

After the end-of-run tidy (keep 1 snapshot) each table holds exactly 1 data file, 1 manifest and
1 manifest list. Lakekeeper keeps the newest ~100 metadata files (gzip): about 0.6-0.9 MB for a
tidied statistics table and 29.5 MB for the untidied one, whose late metadata files are about
300 KB each. The periodic tidies keep 5 snapshots, so the files a compaction replaces stay in the
store until the next tidy; the 3 retained pre-compaction appends still reference them. The
remote-signed DELETEs from snapshot expiry work: the replaced files, manifests and lists are gone.

### Compared with the earlier PyIceberg measurement

| | PyIceberg 0.10, 1,800 commits | Java 1.9.2 through Texera's code, 2,880 commits |
|---|---|---|
| commit, untidied, start -> end | 51 -> 588 ms | 96-120 -> 277-291 ms (p50) |
| metadata, untidied, end | 1.2 MB | 2.2 MB of JSON (0.3 MB as Lakekeeper stores it) |
| files for the day | about 5,500 for 9,000 rows | 2,880 for 28,800 rows (one Parquet file per commit) |
| full read, untidied, end | 5.4 s | 13.8-17.4 s (raw records 9.9-10.2 s) |
| one late tidy | 46 s | 21.5-28.2 s |
| full read after tidying | 13 ms | 468-529 ms through Texera, 22-38 ms as raw records |

A Java commit starts higher, because merge-append does more client work (see the breakdown). It
grows more slowly, probably because merge-append keeps the manifest count under about 100 (at
most 77 were seen), so a commit's manifest list does not grow commit by commit. Reads are slower
because Texera's reader converts row by row, while PyIceberg reads into Arrow tables.

## What it means for the plan

1. **Keep timed commits and tidy in the engine.** A statistics commit costs about 0.1 s through
   Texera's writer, under 0.5% of a 30 s tick, and it stays flat as long as the table is tidied.
   The engine is the only writer, so it can tidy between ticks without conflicts.
2. **Tidy every ~50 commits, not every few hundred.** Every 200 leaves up to 200 small files,
   about 0.7-1 s of per-file read cost on top of the per-row cost. Every 50 caps the per-file part
   at about 0.2 s, and a tidy costs about 0.6 s. That alone is not enough: late in the day the
   per-row part is about 0.5 s, and reads right before a tidy still reached 0.95-1.7 s.
3. **Fix Texera's per-row read cost before promising fast whole-table reads.** Build the Amber
   schema once per read in `DocumentFactory`'s deserializer, and the projected schema once in
   `IcebergDocument`. The raw-record read shows the target: 22-38 ms for a tidied day. It is a
   small change, and it matters for every result page too, not only statistics. With items 2
   and 3 together, the worst read of the day should be about 51 files x 3.5 ms + 28,800 rows x
   1 µs, about 0.2 s. That estimate comes from these measurements; it was not run.
4. **Live views read the newest rows, not the whole table.** In a tidied table the newest tick
   costs at most 21-38 ms the direct way (the newest snapshot's file), against up to 110-170 ms
   through `getCount` + `getRange`, which plans the whole table twice (up to 290 ms untidied). The
   execution's state should come from the `log` table the same way, or from a snapshot-summary
   field (one `loadTable`, 1-5 ms; measured with PyIceberg earlier, not here).
5. **Tidy the `log` at the end with the statistics**, keeping one snapshot. A finished run then
   reads its whole history in 10-15 ms and leaves one file per table.
6. **Consider fast append for the timed writer.** `newFastAppend` costs about 45 ms against about
   80 ms for the `newAppend` (merge append) that `IcebergTableWriter` uses. Tidying rewrites
   manifests anyway, so merge-append's merging adds nothing.
7. **Two cautions for the design:**
   - `IcebergDocument`'s polling reader resumes from a snapshot id. If a tidy expires that
     snapshot, the reader fails. Keep more snapshots than the slowest poller can fall behind, or
     re-plan from the current snapshot when the id is gone. This was not tested here.
   - Texera stores a `TIMESTAMP` as a wall clock without a zone. On the day clocks fall back, two
     instants an hour apart store the same value (the benchmark prints this as `INFO dst`), so a
     day-long run that crosses the change reads its times back out of order. The `log` table
     should store instants with a zone (Iceberg `timestamptz`) or epoch numbers.

## What did not work as assumed, and the workaround

| Assumed | Measured | Workaround |
|---|---|---|
| Tidying every few hundred commits keeps a day-long read well under 1 s. | Texera's reader pays per file and per row. Right before a tidy: a median of 0.8-1.0 s (up to 2.3 s) when tidying every 200 commits, 0.46-0.55 s (up to 1.7 s) every 50. Fully tidied: 0.47-0.53 s. | Tidy every about 50 commits, and fix the per-row conversion (plan items 2 and 3). Live views read the newest rows. |
| A tidied table reads in about 13 ms, as PyIceberg's did. | 468-529 ms through Texera; 22-38 ms as raw Java records. | The difference is Texera's per-row `Tuple` conversion, not Iceberg (item 3). |
| The log's read cost stays tiny. | The newest row does (at most 30 ms). The whole untidied log takes 272-346 ms (49 files at about 6-7 ms each). | Read the state from the newest snapshot; tidy the log at the end (to 10-15 ms). |
| A commit costs about 50 ms (PyIceberg's starting point). | About 100-120 ms through `IcebergTableWriter`, which uses merge append. | Fine for a 30 s timer. `newFastAppend` halves it. |
| Expiring all but the last few snapshots frees the compacted files. | They stay until the next tidy, because the retained pre-compaction appends reference them. | The end-of-run tidy keeps 1 snapshot, which leaves 1 data file per table. |
| A simulated day starting 2026-11-01 reads back in order. | That is the US fall-back day: the 1-2 AM hour read back out of order (zone-less `TIMESTAMP`). | The benchmark simulates 2026-11-10 (`--day-start`); the plan should use zone-aware times (item 7). |
| Lakekeeper and the JVM on the host can share one S3 endpoint. | Lakekeeper writes `metadata.json` itself through the same endpoint it hands to clients. | All lake containers share one network namespace, with RustFS on the same port inside and out (`stack.sh`). |
| One measurement per checkpoint is enough. | The shared machine gave single readings 2-3x slow (4.9 s, 2.9 s). | Medians of 3 for reads under 5 s, plus a second and third run. |

## How to re-run

```bash
./run.sh            # the full day: 3 scenarios x 2,880 commits, about 35-40 minutes
./run.sh --quick    # 120 commits per scenario, about 2 minutes
./run.sh --commits 600 --tidy-every 100 --scenarios tidy,no-tidy   # any benchmark option
```

`run.sh` starts from a clean state, brings up the lake (`stack.sh up`), runs the benchmark through
sbt in this worktree, counts what each table left in the object store, prints one `PASS`/`FAIL`
line per check, tears everything down and checks that nothing named `sce0ice` is left. Raw output
goes to `raw/run-<UTC time>/`. Exit status: 0 all checks passed, 1 the proof ran but a check
failed, 2 the harness itself failed. It needs Docker, sbt with JDK 17, `uv` (for a stdlib-only
Python venv), and the Postgres on `localhost:5432` that sbt's jOOQ code generation uses.

## What runs

**The lake** (`stack.sh`): RustFS 1.0.0, Postgres 15 and Lakekeeper v0.11.0 (`migrate`, then
`serve`), bootstrapped the way `bin/single-node/docker-compose.yml`'s `lakekeeper-init` does it:
the default project (nil UUID), warehouse `texera` on bucket `texera-iceberg`, key prefix `shared`,
region `us-west-2`, `flavor: s3-compat`, `path-style-access: true`, `sts-enabled: false`, and an
access-key storage credential. With STS off, Lakekeeper hands the client remote signing; the
benchmark prints what the client receives (`s3.remote-signing-enabled=true`, an endpoint, a
region, a signer URI, and no S3 keys). Lakekeeper writes each `metadata.json` itself, so its
single S3 endpoint has to work from inside its container and from the JVM on the host: all three
containers share one network namespace, owned by RustFS, which listens on the same port inside and
out (`127.0.0.1:19541`; Lakekeeper is on `127.0.0.1:19540`). Credentials are random per run,
kept in `.state/` (mode 600), never printed, and deleted by `stack.sh down`.

**The benchmark** (`IcebergCommitBench`, in the sbt tree at
`common/workflow-core/src/test/scala/org/apache/texera/amber/core/storage/result/iceberg/bench/`,
copied to `src/`). It is a plain object with `main`, so neither ScalaTest nor JUnit runs it; it
passes `scalafmtCheck` and `scalafix --check`. It uses Texera's own Iceberg code wherever Texera has
it:

| Step | Texera code used |
|---|---|
| Catalog | `IcebergCatalogInstance.getInstance()` builds the `RESTCatalog` with `S3FileIO` through `IcebergUtil.createRestCatalog`, chosen by `storage.conf`'s environment overrides (`STORAGE_ICEBERG_CATALOG_TYPE=rest`, `..._REST_URI`, `..._WAREHOUSE_NAME`). The benchmark wraps it in a delegating catalog that only times `loadTable`. |
| Statistics table | `VFSURIFactory.createRuntimeStatisticsURI` + `DocumentFactory.createDocument(uri, ResultSchema.runtimeStatisticsSchema)`, the call `ExecutionStatsService` makes. `IcebergUtil.createTable` makes it unpartitioned, format v2, with Texera's commit-retry properties. |
| One tick | `doc.writer(id)`, `putOne` for 10 operators' rows (the row `storeRuntimeStatistics` writes), `close()`. That is exactly one `IcebergTableWriter.flushBuffer`: `loadTable`, one Parquet file, `newAppend().appendFile(...).commit()`. Texera today commits only every 4,096 rows; a timed commit is one flush per tick. |
| Reading | `DocumentFactory.openDocument(uri)` and `IcebergDocument.get()` for everything; `getCount` + `getRange(count - 1, count)` for the newest row. |
| Log table | `IcebergUtil.createTable` in a new namespace `execution-log`, read through `IcebergDocument` (what `openDocument` builds). One row (`seq`, `time`, `kind`, `state`, `detail`) per state change, committed at once: READY and RUNNING at the start, PAUSED and RUNNING every hour, COMPLETED at the end, 49 rows in a day. |

Not Texera code, because Texera has none: **tidying**, with core Iceberg APIs only (no Spark).
(1) Compact: plan the current snapshot, read every data file with `IcebergUtil.readDataFileAsIterator`
in Texera's read order (file sequence number), write all rows in that order into one Parquet file
set up like `IcebergTableWriter`'s, and swap it in with a `newRewrite()` (replace) commit that
validates from the planned snapshot. The new file's sequence number sits above every file it
replaces and below every later append, so Texera's reader keeps returning rows in commit order.
(2) `rewriteManifests()` into one group. (3) `expireSnapshots().expireOlderThan(now).retainLast(5)`,
and `retainLast(1)` in the end-of-run tidy. Also not Texera code: the "direct" newest-row read (walk
back to the newest snapshot that added a file and read that file), a raw-record read (the same
planning and `IcebergUtil.readDataFileAsIterator` per file, without turning records into `Tuple`s),
and the probes below.

**Scenarios.** Each is 2,880 ticks of 10 rows (a 30 s timer for 24 hours, 28,800 rows), plus its
own log table. The ticks run back to back, so a simulated day takes 5-17 minutes; the `time`
column carries the simulated time. A real day's 30 s gaps were not reproduced.

- `tidy`: tidy every 200 commits and at the end (the plan's "every few hundred commits").
- `tidy-50`: tidy every 50 commits and at the end (added after the first full run, to test the
  fix that run suggested).
- `no-tidy`: never tidied during the run; both tables are tidied once after the last commit, to
  price a late tidy.

**Measured** at every 250 commits and at the end: commit latency p50/p95 over the window (and the
share of it spent in `loadTable`), `loadTable` time, the metadata as JSON (what every `loadTable`
carries and parses) and as stored (Lakekeeper gzips it), data files, manifests, snapshots, a full
read through Texera's reader, the same read as raw records and as three columns through Texera
(`getRange` with a column list), the newest row (Texera's way and the direct way), and two probes on
a held table: a catalog-only commit (a property change, which still makes Lakekeeper write a whole
metadata file) and writing one 10-row data file. Before and after every tidy: a full read and the
time of each tidy step. Once per run, on a scratch table, a breakdown of where a commit's time goes
(40 of each). After the run, `run.sh` counts each table's objects in the store by kind. Reads that
take under 5 s run three times and report the median (other work on the machine causes outliers);
longer reads run once. A warm-up (50 commits, reads and a tidy on a throwaway table) comes first.

**Checks**, with thresholds fixed before the full runs:

- `<scenario>_rows_complete_ordered`: every full read returns all rows in commit order, both
  newest-row reads return the last tick, and no tidy loses a row.
- `<tidy scenario>_read_all_end_under_1s`, `..._every_checkpoint_under_1s`,
  `..._worst_case_under_1s` (the read right before a tidy, when files are most numerous), and
  `..._commit_latency_flat` (last window's p50 within 1.5x and p95 within 2x of the first window's,
  first 10 commits excluded).
- `log_newest_row_tiny` (under 50 ms all day), `log_read_all_tiny_untidied` and
  `log_read_all_tiny_after_final_tidy` (under 100 ms).
- Harness: `lake_up`, `benchmark_ran`, `teardown_clean`.

## Versions and machine

| Component | Version |
|---|---|
| Texera | worktree `spike/sce-step0-proofs` at `205fe77c4` (apache/texera main, 2026-11-16) |
| Iceberg Java (core, api, data, parquet, aws) | 1.9.2, with Parquet 1.15.2 and AWS SDK v2 2.29.51 (Apache HTTP client) |
| JVM / Scala / sbt | Temurin 17.0.19, Scala 2.13.18, sbt 1.12.9 |
| Lakekeeper | `vakamo/lakekeeper:v0.11.0` (`sha256:e730a4b0ebde...`), allow-all authorizer, no authentication |
| Object store | `rustfs/rustfs:1.0.0` (`sha256:8cc980175544...`), client `rustfs/rc:v0.1.35` |
| Lakekeeper's database | `postgres:15` (`sha256:29342cb52157...`) |
| Machine | Apple M4 (10 cores, 16 GB), macOS 26.5, Docker 29.4.0 on OrbStack (VM: 10 CPUs, 8 GB) |

The machine was shared: other Step 0 proofs, a testcontainers run and a local Kubernetes cluster
ran at the same time (load average 5.5-8 on 10 cores). Single readings occasionally ran 2-3x slow;
the medians and the run-to-run spread below show how much.

## Files

| File | What it is |
|---|---|
| `run.sh` | the entry point |
| `stack.sh` | the lake: `up`, `down`, `env` (the JVM's environment), `objects <s3-location>`, `info` |
| `src/IcebergCommitBench.scala` | copy of the benchmark in the sbt tree (`run.sh` restores it there if missing) |
| `summarize.py` | Markdown tables from one run, or `--compare` across runs (stdlib only) |
| `raw/run-*/checks.txt` | the `PASS`/`FAIL` lines `run.sh` printed, harness checks included |
| `raw/run-*/console.txt` | the benchmark's own output (what the tables here are taken from) |
| `raw/run-*/checkpoints.csv`, `tidy.csv`, `ticks.csv`, `breakdown.csv`, `tables.csv`, `objects.csv` | the raw numbers: every checkpoint, every tidy, every single commit, the commit breakdown, table locations, objects left in the store |
| `raw/run-*/summary.txt` | `summarize.py`'s tables for that run |
| `raw/run-*/sbt-output.txt` | sbt's full output |
