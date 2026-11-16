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

"""Summarize runs of IcebergCommitBench (raw/run-* folders) as Markdown tables.

Usage (standard library only):
  python -I summarize.py <run-dir>                  every table for one run
  python -I summarize.py --compare <run-dir>...     the key numbers of several runs
  python -I summarize.py --checks <run-dir>...      PASS/FAIL per check and run (checks.txt)
"""

import csv
import sys
from pathlib import Path


def load(path):
    if not path.exists():
        return []
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def n(value, digits=0):
    if value in (None, ""):
        return "-"
    x = float(value)
    return f"{x:,.{digits}f}"


def kb(value):
    return "-" if value in (None, "") else f"{float(value) / 1024:,.0f}"


def table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(out)


def main(run_dir):
    d = Path(run_dir)
    checkpoints = load(d / "checkpoints.csv")
    tidies = load(d / "tidy.csv")
    breakdown = load(d / "breakdown.csv")
    objects = load(d / "objects.csv")

    for scenario in ("no-tidy", "tidy"):
        rows = [
            r
            for r in checkpoints
            if r["scenario"] == scenario and r["table"] == "runtime_statistics"
        ]
        if not rows:
            continue
        print(f"\n#### runtime_statistics, {scenario}\n")
        print(
            table(
                [
                    "commits",
                    "phase",
                    "commit p50 / p95 ms",
                    "loadTable ms",
                    "catalog-only commit ms",
                    "metadata JSON KB (stored gz KB)",
                    "data files",
                    "manifests",
                    "snapshots",
                    "read all ms (raw records / 3 columns)",
                    "newest row ms (Texera / direct)",
                ],
                [
                    [
                        r["commits"],
                        r["phase"],
                        f"{n(r['commit_p50_ms'])} / {n(r['commit_p95_ms'])}",
                        n(r["loadtable_ms"], 1),
                        n(r["catalog_only_commit_ms"], 1),
                        f"{kb(r['metadata_json_bytes'])} ({kb(r['metadata_stored_bytes'])})",
                        r["data_files"],
                        r["manifests"],
                        r["snapshots"],
                        f"{n(r['read_all_ms'])} ({n(r.get('read_all_raw_records_ms'))}"
                        f" / {n(r.get('read_all_3_columns_ms'))})",
                        f"{n(r['newest_texera_ms'])} / {n(r['newest_direct_ms'])}",
                    ]
                    for r in rows
                ],
            )
        )

    logs = [r for r in checkpoints if r["table"] == "log"]
    if logs:
        print("\n#### log (one row per state change)\n")
        print(
            table(
                [
                    "scenario",
                    "state changes",
                    "phase",
                    "commit p50 / p95 ms",
                    "loadTable ms",
                    "metadata JSON KB",
                    "data files",
                    "read all ms",
                    "newest row ms (Texera / direct)",
                ],
                [
                    [
                        r["scenario"],
                        r["commits"],
                        r["phase"],
                        f"{n(r['commit_p50_ms'])} / {n(r['commit_p95_ms'])}",
                        n(r["loadtable_ms"], 1),
                        kb(r["metadata_json_bytes"]),
                        r["data_files"],
                        n(r["read_all_ms"]),
                        f"{n(r['newest_texera_ms'])} / {n(r['newest_direct_ms'])}",
                    ]
                    for r in logs
                ],
            )
        )

    if tidies:
        print("\n#### tidies\n")
        print(
            table(
                [
                    "scenario",
                    "table",
                    "at commit",
                    "files / manifests / snapshots before",
                    "read all before ms",
                    "compact ms",
                    "rewrite manifests ms",
                    "expire ms",
                    "total ms",
                    "after",
                    "read all after ms",
                ],
                [
                    [
                        t["scenario"],
                        t["table"],
                        t["commits"],
                        f"{t['data_files_before']} / {t['manifests_before']} / {t['snapshots_before']}",
                        n(t["read_all_before_ms"]),
                        n(t["compact_ms"]),
                        n(t["rewrite_manifests_ms"]),
                        n(t["expire_ms"]),
                        n(t["tidy_total_ms"]),
                        f"{t['data_files_after']} / {t['manifests_after']} / {t['snapshots_after']}",
                        n(t["read_all_after_ms"]),
                    ]
                    for t in tidies
                ],
            )
        )

    if breakdown:
        print("\n#### where a commit's time goes (scratch table)\n")
        print(
            table(
                ["step", "p50 ms", "p95 ms"],
                [[b["step"], n(b["p50_ms"], 1), n(b["p95_ms"], 1)] for b in breakdown],
            )
        )

    if objects:
        print("\n#### what each table left in the store at the end\n")
        print(
            table(
                [
                    "scenario",
                    "table",
                    "objects",
                    "MB",
                    "data files",
                    "manifests",
                    "manifest lists",
                    "metadata files (MB)",
                ],
                [
                    [
                        o["scenario"],
                        o["table"],
                        o["objects"],
                        n(float(o["bytes"]) / 1e6, 1),
                        o["data_files"],
                        o["manifests"],
                        o["manifest_lists"],
                        f"{o['metadata_files']} ({n(float(o['metadata_bytes']) / 1e6, 1)})",
                    ]
                    for o in objects
                ],
            )
        )


def med(values):
    values = sorted(values)
    return values[len(values) // 2] if values else None


def key_numbers(run_dir):
    """One column of the comparison: the numbers the conclusions rest on."""
    d = Path(run_dir)
    checkpoints = load(d / "checkpoints.csv")
    tidies = load(d / "tidy.csv")
    breakdown = {b["step"].split(":")[0]: b for b in load(d / "breakdown.csv")}
    out = {}

    def stats(scenario):
        return [
            r
            for r in checkpoints
            if r["scenario"] == scenario and r["table"] == "runtime_statistics"
        ]

    for scenario in ("tidy", "tidy-50", "no-tidy"):
        rows = stats(scenario)
        if not rows:
            continue
        run = [r for r in rows if r["phase"] == "run"]
        end = rows[-1]
        before = [
            float(t["read_all_before_ms"])
            for t in tidies
            if t["scenario"] == scenario and t["table"] == "runtime_statistics"
        ]
        cost = [
            float(t["tidy_total_ms"])
            for t in tidies
            if t["scenario"] == scenario and t["table"] == "runtime_statistics"
        ]
        out[f"{scenario}: commit p50, first -> last window (ms)"] = (
            f"{n(run[0]['commit_p50_ms'])} -> {n(run[-1]['commit_p50_ms'])}"
        )
        out[f"{scenario}: commit p95, first -> last window (ms)"] = (
            f"{n(run[0]['commit_p95_ms'])} -> {n(run[-1]['commit_p95_ms'])}"
        )
        out[f"{scenario}: read all at checkpoints, min - max (ms)"] = (
            f"{n(min(float(r['read_all_ms']) for r in run))} - "
            f"{n(max(float(r['read_all_ms']) for r in run))}"
        )
        if scenario != "no-tidy":
            out[f"{scenario}: read all right before a tidy, median / max (ms)"] = (
                f"{n(med(before))} / {n(max(before))}"
            )
            out[f"{scenario}: one tidy, median / max (ms)"] = f"{n(med(cost))} / {n(max(cost))}"
        else:
            out["no-tidy: loadTable, first -> last checkpoint (ms)"] = (
                f"{n(run[0]['loadtable_ms'], 1)} -> {n(run[-1]['loadtable_ms'], 1)}"
            )
            out["no-tidy: catalog-only commit, first -> last checkpoint (ms)"] = (
                f"{n(run[0]['catalog_only_commit_ms'], 1)} -> "
                f"{n(run[-1]['catalog_only_commit_ms'], 1)}"
            )
            out["no-tidy: metadata JSON, first -> last checkpoint (KB)"] = (
                f"{kb(run[0]['metadata_json_bytes'])} -> {kb(run[-1]['metadata_json_bytes'])}"
            )
            out["no-tidy: the one tidy at the end (ms)"] = f"{n(cost[-1])}" if cost else "-"
        out[f"{scenario}: whole day after the final tidy, Texera / raw / 3 columns (ms)"] = (
            f"{n(end['read_all_ms'])} / {n(end.get('read_all_raw_records_ms'))} / "
            f"{n(end.get('read_all_3_columns_ms'))}"
        )
        out[f"{scenario}: newest row at checkpoints, direct max / Texera max (ms)"] = (
            f"{n(max(float(r['newest_direct_ms']) for r in run))} / "
            f"{n(max(float(r['newest_texera_ms']) for r in run))}"
        )

    logs = [r for r in checkpoints if r["scenario"] == "tidy" and r["table"] == "log"]
    if logs:
        run = [r for r in logs if r["phase"] == "run"]
        out["log (tidy scenario): whole log at the end of the run, untidied (ms)"] = (
            f"{n(run[-1]['read_all_ms'])} ({run[-1]['data_files']} files)"
        )
        out["log (tidy scenario): whole log after the final tidy (ms)"] = n(logs[-1]["read_all_ms"])
        out["log (tidy scenario): newest row, direct max over the day (ms)"] = n(
            max(float(r["newest_direct_ms"]) for r in run)
        )
    for step, label in (
        ("texera_flush", "commit through Texera's writer"),
        ("held table", None),
    ):
        if step in breakdown and label:
            b = breakdown[step]
            out[f"breakdown: {label}, p50 (ms)"] = n(b["p50_ms"], 1)
    for b in load(d / "breakdown.csv"):
        if b["step"].startswith("held table: new") or b["step"].startswith(
            "held table: catalog"
        ):
            out[f"breakdown: {b['step'][len('held table: '):]}, p50 (ms)"] = n(b["p50_ms"], 1)
    return out


def compare(run_dirs):
    columns = [key_numbers(d) for d in run_dirs]
    keys = []
    for c in columns:
        keys += [k for k in c if k not in keys]
    print(
        table(
            ["measure"] + [Path(d).name for d in run_dirs],
            [[k] + [c.get(k, "-") for c in columns] for k in keys],
        )
    )


def checks(run_dirs):
    """One row per check, one column per run, from each run's checks.txt."""
    results = []
    for d in run_dirs:
        found = {}
        path = Path(d) / "checks.txt"
        for line in path.read_text().splitlines() if path.exists() else []:
            verdict, _, rest = line.partition(" ")
            if verdict in ("PASS", "FAIL"):
                name, _, evidence = rest.partition(": ")
                found[name] = verdict
        results.append(found)
    names = []
    for found in results:
        names += [k for k in found if k not in names]
    print(
        table(
            ["check"] + [Path(d).name for d in run_dirs],
            [[name] + [found.get(name, "-") for found in results] for name in names],
        )
    )


if __name__ == "__main__":
    if sys.argv[1] == "--compare":
        compare(sys.argv[2:])
    elif sys.argv[1] == "--checks":
        checks(sys.argv[2:])
    else:
        main(sys.argv[1])
