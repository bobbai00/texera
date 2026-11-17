"""Build a Texera workflow once and emit it in the two shapes the system takes.

* `logical_plan()` -- what WorkflowExecuteRequest.logicalPlan carries
  (LogicalPlanPojo): operators are their properties spread flat plus
  operatorID/operatorType; links use port ordinals {id, internal:false}.
  Ports are omitted, so every operator gets its declared default ports
  (the frontend sends its port list; the engine accepts either).
* `plan_up_to(target)` -- the same shape, cut to what one operator needs: what a
  client sends to have the workflow run up to that operator.
* `ui_content()` -- the JSON string the dashboard stores for the workflow
  (operators/operatorPositions/links/commentBoxes/settings), so a run's
  workflow can be opened and inspected in the UI.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field


@dataclass
class Op:
    id: str
    type: str
    props: dict
    n_in: int = 1
    n_out: int = 1
    title: str = ""
    in_names: list[str] = field(default_factory=list)


class Workflow:
    def __init__(self, name: str):
        self.name = name
        self.ops: list[Op] = []
        self.links: list[tuple[str, int, str, int]] = []

    def add(self, key: str, op_type: str, props: dict, *, n_in: int = 1, n_out: int = 1,
            title: str = "", in_names: list[str] | None = None) -> str:
        op_id = f"{op_type}-operator-{key}-{uuid.uuid4().hex[:8]}"
        self.ops.append(Op(op_id, op_type, props, n_in, n_out, title or key, in_names or []))
        return op_id

    def link(self, src: str, dst: str, src_port: int = 0, dst_port: int = 0) -> None:
        self.links.append((src, src_port, dst, dst_port))

    def op(self, op_id: str) -> Op:
        return next(o for o in self.ops if o.id == op_id)

    def operator_json(self, op_id: str, **changes) -> dict:
        """One operator as the logical plan carries it (what ModifyLogicRequest and
        POST /api/executions/{eid}/updates take), with `changes` applied."""
        o = self.op(op_id)
        return {**o.props, **changes, "operatorID": o.id, "operatorType": o.type}

    def terminal_ops(self) -> list[str]:
        sources = {s for s, _, _, _ in self.links}
        return [o.id for o in self.ops if o.id not in sources]

    # ------------------------------------------------------------------ shapes

    def logical_plan(self, view_results: list[str] | None = None) -> dict:
        return self._plan(self.ops, self.links, view_results if view_results is not None else self.terminal_ops())

    def plan_up_to(self, target: str) -> dict:
        """The part of the workflow that `target` needs, with `target` to view: it and what
        is upstream of it, as the agent service cuts a plan it runs up to one operator
        (agent-service, WorkflowState.getSubDAG). The Dashboard is not asked to cut."""
        needed, todo = set(), [target]
        while todo:
            op = todo.pop()
            if op not in needed:
                needed.add(op)
                todo += [s for s, _, d, _ in self.links if d == op]
        return self._plan([o for o in self.ops if o.id in needed], [ln for ln in self.links if ln[2] in needed],
                          [target])

    @staticmethod
    def _plan(ops: list[Op], links: list[tuple[str, int, str, int]], view: list[str]) -> dict:
        return {
            "operators": [{**o.props, "operatorID": o.id, "operatorType": o.type} for o in ops],
            "links": [
                {
                    "fromOpId": s,
                    "fromPortId": {"id": sp, "internal": False},
                    "toOpId": d,
                    "toPortId": {"id": dp, "internal": False},
                }
                for s, sp, d, dp in links
            ],
            "opsToViewResult": list(view),
            "opsToReuseResult": [],
        }

    def ui_content(self) -> dict:
        def port(prefix: str, i: int, name: str = "") -> dict:
            return {"portID": f"{prefix}-{i}", "displayName": name, "allowMultiInputs": False,
                    "isDynamicPort": False}

        depth: dict[str, int] = {o.id: 0 for o in self.ops}
        for _ in self.ops:  # longest-path layering, enough for these small DAGs
            for s, _, d, _ in self.links:
                depth[d] = max(depth[d], depth[s] + 1)
        rows: dict[int, int] = {}
        positions = {}
        for o in self.ops:
            col = depth[o.id]
            positions[o.id] = {"x": 80 + 220 * col, "y": 80 + 140 * rows.get(col, 0)}
            rows[col] = rows.get(col, 0) + 1

        return {
            "operators": [
                {
                    "operatorID": o.id,
                    "operatorType": o.type,
                    "operatorVersion": "N/A",
                    "operatorProperties": o.props,
                    "inputPorts": [port("input", i, o.in_names[i] if i < len(o.in_names) else "")
                                   for i in range(o.n_in)],
                    "outputPorts": [port("output", i) for i in range(o.n_out)],
                    "showAdvanced": False,
                    "isDisabled": False,
                    "customDisplayName": o.title,
                    "dynamicInputPorts": False,
                    "dynamicOutputPorts": False,
                }
                for o in self.ops
            ],
            "operatorPositions": positions,
            "links": [
                {
                    "linkID": f"link-{uuid.uuid4()}",
                    "source": {"operatorID": s, "portID": f"output-{sp}"},
                    "target": {"operatorID": d, "portID": f"input-{dp}"},
                }
                for s, sp, d, dp in self.links
            ],
            "commentBoxes": [],
            "settings": {"dataTransferBatchSize": 400},
        }


# ------------------------------------------------------------ operator helpers


def csv_scan(path: str) -> dict:
    return {"fileName": path, "fileEncoding": "UTF_8", "customDelimiter": ",", "hasHeader": True}


def python_udf(code: str, *, out_columns: list[tuple[str, str]] | None = None,
               retain_input: bool = True, workers: int = 1, env_name: str | None = None) -> dict:
    """`env_name` names a Python environment (defaultEnv false); None runs the engine's own."""
    return {
        "code": code,
        "workers": workers,
        "retainInputColumns": retain_input,
        "defaultEnv": env_name is None,
        "envName": env_name or "",
        "outputColumns": [{"attributeName": n, "attributeType": t} for n, t in (out_columns or [])],
    }


def text_input(lines: list[str], attribute: str = "line") -> dict:
    """TextInput: one string tuple per line."""
    return {"textInput": "\n".join(lines), "attributeType": "string", "attributeName": attribute}


def file_lister(version_path: str) -> dict:
    """FileLister: one `filename` tuple per file of /dataset/<owner email>/<name>/<version>."""
    return {"datasetVersionPath": version_path}


def file_scan_from_input(attribute_type: str = "single string", output_file_name: bool = True,
                         attribute: str = "line") -> dict:
    """FileScanOp (File Scan From Input): reads the files named by its input tuples.
    attribute_type "single string" reads each file whole into one tuple."""
    return {"fileEncoding": "UTF_8", "extract": False, "outputFileName": output_file_name,
            "attributeType": attribute_type, "attributeName": attribute}


def filter_op(*predicates: tuple[str, str, str]) -> dict:
    """predicates are OR-ed: (attribute, condition, value), condition in = > >= < <= != ..."""
    return {"predicates": [{"attribute": a, "condition": c, "value": v} for a, c, v in predicates]}


def projection(*attrs: tuple[str, str]) -> dict:
    """(original attribute, alias or '')."""
    return {"isDrop": False, "attributes": [{"originalAttribute": a, "alias": al} for a, al in attrs]}


def aggregate(group_by: list[str], *aggs: tuple[str, str, str]) -> dict:
    """aggs: (function sum|count|average|min|max|concat, attribute, result attribute)."""
    return {
        "aggregations": [{"aggFunction": f, "attribute": a, "result attribute": r} for f, a, r in aggs],
        "groupByKeys": group_by,
    }


def hash_join(build_attr: str, probe_attr: str, join_type: str = "inner") -> dict:
    """Input port 0 (left) is the build side, port 1 (right) the probe side."""
    return {"buildAttributeName": build_attr, "probeAttributeName": probe_attr, "joinType": join_type}


def sort_op(*keys: tuple[str, str]) -> dict:
    """keys: (attribute, ASC|DESC)."""
    return {"attributes": [{"attribute": a, "sortPreference": p} for a, p in keys]}
