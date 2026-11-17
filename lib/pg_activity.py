"""Who is connected to Postgres: the query of pg_stat_activity behind the stack
control's `pg_activity()` (step-3 design, section 7 H1), which shows whether the
computing unit holds a connection, and how its answer is read. Shared by the driver,
which asks the single-node stack's Postgres itself, and by the Kubernetes and local-dev
stack scripts, which ask theirs for the driver.
"""

from __future__ import annotations

#: one line per client connection but the asking one: pid|application name|client address|database|state
QUERY = ("SELECT pid, COALESCE(application_name, ''), COALESCE(host(client_addr), ''), "
         "COALESCE(datname, ''), COALESCE(state, '') FROM pg_stat_activity "
         "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY pid")
#: psql's arguments after the connection options; the output is unaligned, tuples only
PSQL_ARGS = ("-v", "ON_ERROR_STOP=1", "-AtF", "|", "-c", QUERY)


def parse(text: str) -> list[dict]:
    """The backends in psql's answer to QUERY. Only the application name may hold the
    separator, so a line is split from both ends."""
    backends = []
    for line in text.splitlines():
        pid, sep, rest = line.partition("|")
        if not sep or not pid.strip().isdigit() or rest.count("|") < 3:
            continue
        app, addr, db, state = rest.rsplit("|", 3)
        backends.append({"pid": int(pid), "application_name": app, "client_addr": addr, "datname": db,
                         "state": state})
    return backends
