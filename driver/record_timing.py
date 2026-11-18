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
    #: a verdict gives way to the ending its log shows for this long, and its execution keeps
    #: its results for as long
    revise_verdict_for_s: float = 3600.0
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
    def lost_watch_s(self) -> float:
        """How long an execution's beat must stand still before the closing job calls its
        unit lost: lost-after, and never less than four beats (design D26)."""
        return max(self.lost_after_s, 4 * self.commit_interval_s)

    @property
    def lost_verdict_s(self) -> float:
        """A lost unit's execution is closed within this long of the unit's death: the
        watch, and three ticks of the closing job (design H3, H4)."""
        return self.lost_watch_s + 3 * self.closing_interval_s

    @property
    def never_started_verdict_s(self) -> float:
        """An execution nobody starts is closed within this long of its creation (design H3)."""
        return self.never_started_after_s + 2 * self.closing_interval_s

    @property
    def replaced_verdict_s(self) -> float:
        """An ended execution's results are gone within this long of the start of a later
        execution of its workflow on its unit. The closing job's expiry replaces them once
        the later one's label shows that it has started
        (docs/step3-notes/changes-since-rev2.md, section 4): that label is written within a
        commit interval, the expiry looks every check interval, the job ticks in between."""
        return self.commit_interval_s + self.expiry_check_interval_s + 2 * self.closing_interval_s

    @property
    def expired_verdict_s(self) -> float:
        """Results that nothing replaces are gone within this long of their run's end: the
        TTL, one look of the expiry and two ticks of the closing job (design H3)."""
        return self.result_ttl_s + self.expiry_check_interval_s + 2 * self.closing_interval_s

    @property
    def poll_s(self) -> float:
        """How often a scenario looks while it waits for the closing job."""
        return min(0.5, self.closing_interval_s / 4)

    def describe(self) -> dict:
        return {f.name: getattr(self, f.name) for f in fields(self)} | {"fast": self.fast}
