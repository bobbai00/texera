"""Offline tests of driver/lake.py: what the driver reads of a table from the catalog's
answers (the Iceberg REST LoadTableResult and table listing), against the fake lake and
against answers written out here in the shapes catalogs give them.

    .venv/bin/python -m unittest discover -s driver/tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import lake  # noqa: E402
from fake_lake import FakeLake  # noqa: E402

LOADED = {
    "metadata-location": "s3://b/t/metadata/00003.json",
    "metadata": {
        "format-version": 2,
        "properties": {"texera.execution.state": "COMPLETED", "texera.execution.state-seq": "6",
                       "texera.execution.state-time-ms": "1794873600123", "texera.execution.reason": "",
                       "texera.execution.beat-ms": "1794873600500", "texera.execution.beat-every-ms": "2000"},
        "current-snapshot-id": 8,
        "snapshots": [{"snapshot-id": 8, "timestamp-ms": 1794873600600,
                       "summary": {"operation": "replace", "total-records": "6", "total-data-files": "1",
                                   "total-files-size": "2048"}}],
        "refs": {"main": {"snapshot-id": 8, "type": "branch"}},
    },
}


def answering(answers: dict[str, tuple[int, object]], asked: list[str]) -> lake.Fetch:
    """A Fetch that serves `answers` by path (404 for any other) and notes what was asked."""
    def fetch(path: str) -> subprocess.CompletedProcess:
        asked.append(path)
        status, body = answers.get(path, (404, {"error": {"message": "Table does not exist"}}))
        return subprocess.CompletedProcess(["curl"], 0, f"{json.dumps(body)}\n{status}", "")
    return fetch


class CatalogTest(unittest.TestCase):
    CONFIG = {"/v1/config?warehouse=user-1-7": (200, {"overrides": {"prefix": "abc"}, "defaults": {}})}

    def catalog(self, answers: dict | None = None):
        self.asked: list[str] = []
        return lake.Catalog(answering({**self.CONFIG, **(answers or {})}, self.asked))

    def test_a_tidied_log_table(self):
        c = self.catalog({"/v1/abc/namespaces/execution-log/tables/wid_12_eid_345_executionlog": (200, LOADED)})
        t = lake.Lake(c).table("user-1-7", 12, 345, "log")
        self.assertEqual((True, "", 1, 1, 6, 2048), (t.exists, t.error, t.snapshots, t.data_files, t.records,
                                                     t.size_bytes))
        label = lake.Label.of(t)
        self.assertEqual(("COMPLETED", 6, 1794873600123, "", 1794873600500, 2000),
                         (label.state, label.state_seq, label.state_time_ms, label.reason, label.beat_ms,
                          label.beat_every_ms))
        # the warehouse's prefix is asked for once
        lake.Lake(c).table("user-1-7", 12, 345, "log")
        self.assertEqual(1, sum(p.startswith("/v1/config") for p in self.asked))

    def test_a_table_nothing_was_written_to(self):
        """A catalog writes "no snapshot" as a missing key, as null or as -1."""
        for current in ({}, {"current-snapshot-id": None}, {"current-snapshot-id": -1}):
            body = {"metadata": {"properties": {"texera.execution.beat-ms": "5"}, "snapshots": [], **current}}
            c = self.catalog({"/v1/abc/namespaces/operator-console-messages/tables/wid_1_eid_2_consolemessages":
                              (200, body)})
            t = lake.Lake(c).table("user-1-7", 1, 2, "console")
            self.assertEqual((True, 0, 0, 0), (t.exists, t.snapshots, t.data_files, t.records), current)
            self.assertIsNone(lake.Label.of(t).state)

    def test_a_missing_table_is_an_answer_and_an_outage_is_not(self):
        t = lake.Lake(self.catalog()).table("user-1-7", 1, 2, "statistics")
        self.assertEqual((False, ""), (t.exists, t.error))
        self.assertIn("no such table", t.describe())
        down = self.catalog({"/v1/abc/namespaces/workflow-runtime-statistics/tables/wid_1_eid_2_runtimestatistics":
                             (503, {"error": {"message": "upstream unavailable"}})})
        t = lake.Lake(down).table("user-1-7", 1, 2, "statistics")
        self.assertEqual((False, "HTTP 503 upstream unavailable"), (t.exists, t.error))
        unknown = lake.Lake(lake.Catalog(answering({}, []))).table("nope", 1, 2, "log")
        self.assertIn("catalog config for warehouse nope: HTTP 404", unknown.error)

    def test_curl_that_fails_is_an_outage(self):
        c = lake.Catalog(lambda path: subprocess.CompletedProcess(["curl"], 7, "Failed to connect", ""))
        self.assertEqual((0, "Failed to connect"), c.get("/v1/config"))
        self.assertTrue(lake.Lake(c).table(None, 1, 2, "log").error)

    def test_a_summary_without_totals_is_unknown_not_zero(self):
        body = {"metadata": {"current-snapshot-id": 3, "snapshots": [{"snapshot-id": 3, "summary": {}}]}}
        c = self.catalog({"/v1/abc/namespaces/execution-log/tables/wid_1_eid_2_executionlog": (200, body)})
        t = lake.Lake(c).table("user-1-7", 1, 2, "log")
        self.assertEqual((1, None, None), (t.snapshots, t.data_files, t.records))

    def test_namespaces_follow_the_services_settings(self):
        c = self.catalog({"/v1/abc/namespaces/my-logs/tables/wid_1_eid_2_executionlog": (200, LOADED)})
        own = lake.Lake(c, env={"STORAGE_ICEBERG_TABLE_EXECUTION_LOG_NAMESPACE": "my-logs"})
        self.assertTrue(own.table("user-1-7", 1, 2, "log").exists)
        self.assertEqual("operator-port-result", own.namespaces["result"])


class FakeLakeTest(unittest.TestCase):
    """The reader against the fake lake: tables as the fake recorder leaves them."""

    def setUp(self):
        self.fake = FakeLake()
        self.lake = lake.Lake(lake.Catalog(self.fake.fetch), "texera")

    def test_appends_properties_and_a_tidy(self):
        table = self.fake.create("texera", "execution-log", "wid_1_eid_2_executionlog")
        table.set_properties({"texera.execution.beat-ms": "1"})
        self.assertEqual((0, 0), (self.lake.table(None, 1, 2, "log").snapshots,
                                  self.lake.table(None, 1, 2, "log").records))
        for seq in (1, 2, 3):
            table.append([{"seq": seq}], {"texera.execution.state-seq": str(seq)})
        t = self.lake.table(None, 1, 2, "log")
        self.assertEqual((3, 3, 3, 3), (t.snapshots, t.data_files, t.records, lake.Label.of(t).state_seq))
        table.tidy(at_end=False)  # merged; young snapshots stay
        t = self.lake.table(None, 1, 2, "log")
        self.assertEqual((1, 3), (t.data_files, t.records))
        self.assertGreater(t.snapshots, 1)
        table.tidy(at_end=True)
        t = self.lake.table(None, 1, 2, "log")
        self.assertEqual((1, 1, 3, 3), (t.snapshots, t.data_files, t.records, lake.Label.of(t).state_seq))

    def test_port_tables_are_found_by_name_over_several_pages(self):
        port = "(logicalOpId=Filter-operator-x,layerName=main,portId=0,isInternal=false,isInput=false)"
        self.fake.page_size = 2
        for eid in (3, 34, 5, 6):
            self.fake.create("texera", "operator-port-result", f"wid_1_eid_{eid}_globalportid_{port}_result")
        names, why = self.lake.port_tables(None, 1, 3, "result")
        self.assertEqual(([f"wid_1_eid_3_globalportid_{port}_result"], ""), (names, why))  # not execution 34's
        self.assertGreaterEqual(sum("/tables?pageToken=" in r for r in self.fake.requests), 1)
        # a name with brackets, commas and equal signs is asked for percent-encoded
        t = self.lake.catalog.load_table("texera", "operator-port-result", names[0])
        self.assertTrue(t.exists)
        self.assertIn("%28logicalOpId%3DFilter", self.fake.requests[-1])
        self.assertEqual(([], ""), self.lake.port_tables(None, 1, 3, "state"))  # no such namespace yet
        self.fake.unreadable = True
        names, why = self.lake.port_tables(None, 1, 3, "result")
        self.assertIsNone(names)
        self.assertIn("HTTP 503", why)


if __name__ == "__main__":
    unittest.main()
