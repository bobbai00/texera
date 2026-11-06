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
---
name: texera-workflows
description: Build, validate, run and edit Texera workflows - the spec JSON, dataset file URIs, the common operators with their exact properties, and JSON Patch edits.
---

# Texera workflows

A workflow's spec is a dataflow graph: `operators` and `links`. Each operator has an `operatorID` you choose (short, unique, lowercase), an exact `operatorType` from the registry, and `operatorProperties` named exactly as the operator's JSON Schema names them. Ports are `input-0`, `input-1`, ... and `output-0`; a link joins `{operatorID, portID}` to `{operatorID, portID}`. Set `"viewResult": true` on every operator whose output you will read.

```json
{"operators": [
  {"operatorID": "scan", "operatorType": "CSVFileScan",
   "operatorProperties": {"fileName": "texera://datasets/<rid>@<vno>/files/iris.csv", "fileEncoding": "UTF_8", "hasHeader": true, "customDelimiter": ","},
   "outputPorts": [{"portID": "output-0"}]},
  {"operatorID": "avg", "operatorType": "Aggregate", "viewResult": true,
   "operatorProperties": {"groupByKeys": ["Species"], "aggregations": [{"aggFunction": "average", "attribute": "PetalLengthCm", "result attribute": "avg_petal_length"}]},
   "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}]}],
 "links": [{"linkID": "l1", "source": {"operatorID": "scan", "portID": "output-0"}, "target": {"operatorID": "avg", "portID": "input-0"}}]}
```

## Data

A property whose schema says `format: credential` takes a credential URI, `texera://credentials/<rid>` (find them with `search_resources` kind `credential`); the catalog leases the secret when the workflow runs and puts it in the plan, so the spec never holds a value. A custom operator (an `operatorType` that is an operator URI) receives its instance properties in its code as the dict `PROPS`.

A scan reads a dataset file through its URI `texera://datasets/<dataset rid>@<version>/files/<path>`: the dataset URI `search_resources` returns, the version number, and the path `list_dataset_files` returns. Read the file's first lines with `read_dataset_file` first: they settle the header, the delimiter, and how numbers and missing values are written. The columns of a CSV scan are the header's cells verbatim, case and spaces included; types are inferred from the values.

## The cycle

1. `create_workflow` with the whole plan as `spec` (plus a `name`), or `edit_workflow` on an existing workflow.
2. `validate_workflow`: it compiles the plan on the unit and returns each operator's output schema per port and the errors per operator. Fix every error, then validate again. The schemas give the exact column names and types the next operator sees.
3. `run_workflow` with `waitSeconds` (120 for small data) so the execution comes back with `status.phase`, the operators' states and the port results it kept (`status.ports`). A failed execution names the operator and the error: fix the plan (a new version) and run again.
4. `get_port_result` with the workflow rid, the execution rid (`eid`), the `operatorID` and the `portID` for the rows you need, paged; only operators with `viewResult` keep rows.

Every `create_workflow` and `edit_workflow` makes a new version; an execution names the version it ran. Reuse the workflow rid from the turn state; never invent ids.

## Common operators (exact types and properties)

| Operator | Inputs -> outputs | Properties |
| --- | --- | --- |
| `CSVFileScan` | -> 1 | `fileName` (a dataset file URI), `fileEncoding` `"UTF_8"`, `hasHeader` `true`, `customDelimiter` `","`; optional `limit`, `offset` |
| `JSONLFileScan` | -> 1 | `fileName`, `fileEncoding`, `flatten` `false` |
| `Projection` | 1 -> 1 | `attributes: [{"originalAttribute": "col", "alias": "new name"}]` (alias optional); `isDrop` `false` keeps only these columns, `true` drops them |
| `Filter` | 1 -> 1 | `predicates: [{"attribute": "col", "condition": "=", "value": "x"}]`; conditions `=`, `!=`, `>`, `>=`, `<`, `<=`, `is null`, `is not null`; several predicates are OR-ed, so chain Filters for AND; `value` is a string compared as the column's type |
| `Aggregate` | 1 -> 1 | `groupByKeys: ["col"]` (omit for one overall row); `aggregations: [{"aggFunction": "sum", "attribute": "col", "result attribute": "total"}]`; functions `sum`, `count`, `average`, `min`, `max`, `concat`; `count` needs no `attribute`; `sum`/`average`/`min`/`max` need a numeric or timestamp column, so cast text first |
| `Sort` | 1 -> 1 | `attributes: [{"attribute": "col", "sortPreference": "DESC"}]` (`ASC` or `DESC`) |
| `Limit` | 1 -> 1 | `limit`; sort first for a top-k |
| `Distinct` | 1 -> 1 | none; whole-row distinct |
| `HashJoin` | 2 -> 1 | `buildAttributeName` (the left input, `input-0`), `probeAttributeName` (the right input, `input-1`), `joinType` `inner`, `left outer`, `right outer` or `full outer` |
| `Union` | n -> 1 | none; link every input to `input-0`; schemas must match |
| `TypeCasting` | 1 -> 1 | `typeCastingUnits: [{"attribute": "col", "resultType": "double"}]`; types `string`, `integer`, `long`, `double`, `boolean`, `timestamp` |
| `KeywordSearch` | 1 -> 1 | `attribute`, `keyword`, `isCaseSensitive` |
| `Regex` | 1 -> 1 | `attribute`, `regex`, `caseInsensitive` |
| `RandomKSampling` | 1 -> 1 | `random k sample percentage` (an integer) |
| `Difference`, `Intersect`, `SymmetricDifference` | 2 -> 1 | none |
| `PythonUDFV2` | 1 -> 1 | the `python-udf` skill |

Charts (`BarChart`: `fields`, `value`; `LineChart`: `lines: [{"x": "col", "y": "col", "mode": "line"}]`; `Scatterplot`: `xColumn`, `yColumn`; `Histogram`: `value`; `PieChart`: `name`, `value`) render on the execution's page; compute the numbers you report with table operators.

For any other operator, `list_operators` with `q` set to its name returns its JSON Schema. Never call it without `q`: the whole registry is far too large to read.

## Editing

`edit_workflow` applies an RFC 6902 JSON Patch to the head spec: `[{"op": "add", "path": "/operators/-", "value": {...}}, {"op": "add", "path": "/links/-", "value": {...}}, {"op": "replace", "path": "/operators/1/operatorProperties/limit", "value": 5}]`. Indexes follow the operator order `get_workflow` shows. Validate after editing, then rerun: earlier results are stale.

People can have the workflow open in the editor and change it while you work. Pass `expectedHead`: the `head` that `get_workflow`, or your own last edit, returned. If someone changed the workflow in between, the edit is refused as a conflict instead of landing on the wrong operator; `get_workflow` again and redo the edit on what is there now.
