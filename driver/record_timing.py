"""How often the unit commits an execution's record and the Dashboard service closes
executions (step-3 design, section 3.7), as the stack under test was started.

The scenarios' waits and deadlines are multiples of these timers, never fixed
numbers of seconds: a stack started with `--fast-record` gives a verdict in
seconds, one with the product's defaults in minutes. The stack scripts write the
timers they set into their manifest (`options.record_timing`, lib/record_env.py);
a timer the manifest does not name keeps the product's default.
"""

from __future__ import annotations

from dataclasses import dataclass, fields


@dataclass(frozen=True)
class RecordTiming:
    """Seconds. The defaults are the product's (design 3.7)."""

    #: the unit: statistics, console output and the beat reach the lake this often
    commit_interval_s: float = 30.0
    #: the Dashboard's closing job ticks this often
    closing_interval_s: float = 30.0
    #: an execution whose beat stood still this long has lost its unit
    lost_after_s: float = 180.0
    #: an execution created and not started for this long is closed
    never_started_after_s: float = 600.0
    #: results are dropped this long after their run ended
    result_ttl_s: float = 86400.0
    #: how often the closing job looks for results past that age
    expiry_check_interval_s: float = 86400.0

    @classmethod
    def from_manifest(cls, manifest: dict) -> "RecordTiming":
        given = ((manifest.get("options") or {}).get("record_timing")) or {}
        values = {}
        for f in fields(cls):
            if f.name in given:
                values[f.name] = float(given[f.name])
        if "commit_interval_ms" in given:
            values["commit_interval_s"] = float(given["commit_interval_ms"]) / 1000.0
        return cls(**values)

    @property
    def fast(self) -> bool:
        """Whether a scenario can wait these timers out (a stack started with --fast-record)."""
        return max(self.commit_interval_s, self.closing_interval_s, self.lost_after_s,
                   self.never_started_after_s, self.result_ttl_s, self.expiry_check_interval_s) <= 60

    @property
    def poll_s(self) -> float:
        """How often a scenario looks while it waits for the closing job."""
        return min(0.5, self.closing_interval_s / 4)

    def describe(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)} | {"fast": self.fast}
