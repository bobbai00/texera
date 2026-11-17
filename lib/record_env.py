"""The timers of step 3 that the stacks can shorten (design sections 3.7 and 7 H2).

The unit commits an execution's statistics and console output, and refreshes its
beat, on one timer; the Dashboard service closes executions and expires results on
others. With the product's defaults a verdict takes minutes and an expiry a day, so
`--fast-record` gives both services the short values below. Each stack hands them
over in its own way (compose environment, Helm values, exports before a JVM
starts) and writes into its manifest, under `options.record_timing`, the timers its
services were given. The driver reads them there and assumes the product's default
for a timer the manifest does not name.
"""

from __future__ import annotations

#: manifest key -> (the service that reads the timer, its environment variable)
TIMERS = {
    "commit_interval_ms": ("unit", "STORAGE_ICEBERG_TABLE_COMMIT_INTERVAL_MS"),
    "closing_interval_s": ("dashboard", "EXECUTION_CLOSING_INTERVAL_SECONDS"),
    "lost_after_s": ("dashboard", "EXECUTION_CLOSING_LOST_AFTER_SECONDS"),
    "never_started_after_s": ("dashboard", "EXECUTION_CLOSING_NEVER_STARTED_AFTER_SECONDS"),
    "result_ttl_s": ("dashboard", "RESULT_CLEANUP_TTL_IN_SECONDS"),
    "expiry_check_interval_s": ("dashboard", "RESULT_CLEANUP_COLLECTION_CHECK_INTERVAL_IN_SECONDS"),
}
#: what --fast-record sets (design H2)
FAST_RECORD = {
    "commit_interval_ms": 2000,
    "closing_interval_s": 2,
    "lost_after_s": 12,
    "never_started_after_s": 15,
    "result_ttl_s": 20,
    "expiry_check_interval_s": 5,
}


def fast_record_env(service: str) -> dict[str, str]:
    """The environment --fast-record gives `service` ("unit" or "dashboard")."""
    return {env: str(FAST_RECORD[key]) for key, (reader, env) in TIMERS.items() if reader == service}


def record_timing(unit_env: dict[str, str], dashboard_env: dict[str, str]) -> dict[str, int]:
    """The timers the two services were given, by manifest key. A timer that is not
    set (the product's default applies) or is not a whole number is left out."""
    given = {"unit": unit_env, "dashboard": dashboard_env}
    timing = {}
    for key, (reader, env) in TIMERS.items():
        value = str(given[reader].get(env, "")).strip()
        if value.isdigit():
            timing[key] = int(value)
    return timing
