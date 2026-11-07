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
description: Build, run and change Texera workflows written as lines - the core operators and their settings, the SQL expressions they take, dataset files by name, and how a mistake comes back.
---

# Texera workflows

A workflow is written as lines, one per operator. Each line names the operators it reads in its parentheses:

```
set readings: scan(file="CGM readings/cgm.csv")
set night: filter(readings, where="hour(taken_at) >= 22 or hour(taken_at) < 6")
set lows: aggregate(night, by=["patient_id"], outputs=["readings = count(*)", "lows = count_if(glucose < 70)"])
set labs: scan(file="Clinical labs@2/labs.csv")
set risk: join(lows, labs, on=["patient_id"])
set ranked: sort(risk, by=["lows desc", "patient_id"])
```

- `set <id>: <operator>(<inputs>, <setting>=<value>, ...)` creates an operator, or replaces it whole when the id exists, settings and inputs; what reads it keeps reading it. `delete <id>` removes one, once nothing reads it.
- An id is short: letters, digits and `-`, never `_` (`join-labs`, not `join_labs`).
- Inputs come first, in port order: a join's left, then its right. A scan reads none; a union reads one or more.
- Values: `"text"` or `'text'`, `12`, `1.5`, `true`, `false`, `null`, lists `["a", "b"]`, maps `{"old": "new"}`. An expression is text, so it is quoted: `where="glucose < 70"`. Code over several lines goes in `"""..."""`, taken as it is.

## The cycle

1. `create_workflow` with a `name` and its `lines` saves the workflow in the chat's project and compiles it on a unit. It answers with `lines` (the workflow as it stands), `columns` (each operator's output columns and types) and, when something is wrong, `errors`: each with the `line` that made it and what is wrong, such as `where: the input has no column "taken"; did you mean "taken_at"?`. `waitingOnTheFix` names the operators that only read a broken one: they compile once it is fixed. A line that cannot be read, or an input that is not there, refuses the whole call with the line's number, and nothing is saved.
2. Fix it with `edit_workflow`, sending only the lines that change: `set` the operator again, whole. Write each line against the `columns` of what it reads. Repeat until no errors are left.
3. `run_workflow` with `waitSeconds` (120 for small data) runs it and returns the execution: `status.phase`, each operator's state and row counts, and the results it kept. A run keeps the rows of the operators nothing reads from, and of the operator `upTo` names: `run_workflow` with `upTo` runs only what leads to that operator, without changing the workflow. A failed execution names the operator and its error: fix that line and run again.
4. `get_port_result` with the workflow rid, the execution rid (`eid`), the `operatorID` and `portID` `output-0` returns the rows, paged.

Every create and edit makes a version, and an execution names the version it ran. `get_workflow` reads a workflow as lines. People may have a workflow open and change it while you work, and an edit lands on the newest version: read the lines with `get_workflow` before you change a workflow you did not just write. Reuse the workflow rid from the turn state; never invent ids.

## Files

`file` takes a dataset file:

- by name: `"CGM readings/cgm.csv"` reads the dataset's newest version, `"CGM readings@3/cgm.csv"` pins version 3, and a dataset of one file needs no path: `"CGM readings"`. A name is looked up in the chat's project; when two datasets share it, use the URI.
- by URI: `texera://datasets/<rid>@<version>/files/<path>`, from `search_resources` and `list_dataset_files`.

The answer's lines show the URI at the version used. Before you write a scan, read the file's first lines with `read_dataset_file`: they settle the header, the delimiter, and how numbers and missing values are written. A column is named by its header cell as written, case and spaces included; its type is read off the first rows.

## The core operators

| Operator | Reads | Settings |
| --- | --- | --- |
| `scan` | nothing | `file`; `format` `"auto"` (by the extension), `"csv"`, `"tsv"` or `"json"` (one object per line); `header` `true`; `delimiter`, one character |
| `filter` | 1 | `where`: a condition; keeps the rows where it is true, so a NULL drops the row |
| `project` | 1 | `keep`: the columns to keep, in order; `drop`: the columns to leave out; `rename`: `{"old": "new"}` |
| `compute` | 1 | `columns`: `["name = expression", ...]`; a name the input has is replaced where it stands, a new one is added at the end |
| `aggregate` | 1 | `by`: the group columns (none: one row of everything); `outputs`: `["name = aggregate", ...]` |
| `join` | 2: left, right | `on`: `["patient_id"]`, or `["left_column = right_column"]`; `how`: `"inner"` (the default), `"left"`, `"right"`, `"full"`, `"semi"` or `"anti"` |
| `union` | 1 or more | none; every input has the same columns |
| `distinct` | 1 | `columns`: those that make two rows the same (none: all of them); keeps the first row of each |
| `sort` | 1 | `by`: `["glucose desc", "patient_id"]`; `nulls`: `"last"` (the default) or `"first"` |
| `limit` | 1 | `n`; `offset` |

A join's output has the left's columns, then the right's without its keys; NULL keys never match. A column both sides have, other than a key, is an error: rename one with `project` first. `semi` and `anti` keep the left rows with a match, or without one, each once, with the left's columns. For a top-k, sort, then limit.

## Expressions

`where`, `columns` and `outputs` take SQL, checked against the input's columns before anything runs.

- A column is its name: `glucose`. A name with spaces or other characters is in double quotes, `"Blood Pressure"`, and then must match exactly; an unquoted name matches whatever its case. Text is in single quotes: `sex = 'F'`. Quote the line's text with the other kind: `where='"Blood Pressure" >= 80'`, `where="sex = 'F'"`. An output name with spaces is quoted too: `"time in range" = avg(...)`.
- Operators: `+ - * / %`; `/` always gives a double, and dividing by zero gives NULL; `||` joins text; `= != <> < <= > >=`; `and`, `or`, `not`; `is [not] null`; `[not] in (1, 2)`; `[not] between 70 and 180`; `[not] like 'P-%'`; `case when glucose < 70 then 'low' when glucose > 180 then 'high' else 'in range' end`.
- Types: `cast(x as double)` fails on a value it cannot read; `try_cast(x as integer)` gives NULL instead. Types are `integer`, `long`, `double`, `text`, `boolean` and `timestamp`. A timestamp compares with text written as a time: `taken_at >= '2026-11-01'`.
- Functions: `abs`, `round(x, digits)`, `floor`, `ceil`, `sqrt`, `ln`, `log10`, `exp`, `power`, `greatest`, `least`; `coalesce`, `nullif`; `lower`, `upper`, `trim`, `length`, `substr`, `replace`, `concat`, `starts_with`, `ends_with`, `contains`, `regexp_matches`, `regexp_replace`, `split_part`; `year`, `month`, `day`, `hour`, `minute`, `second`, `dayofweek`, `date`, `date_trunc('hour', t)`, `date_diff('day', a, b)`.
- Aggregates, in `outputs` only: `count(*)`, `count(x)`, `count(distinct x)`, `count_if(condition)`, `sum`, `avg` (or `mean`), `min`, `max`, `median`, and `stddev` and `variance` of a sample. They skip NULLs; a group with nothing to aggregate gives NULL, and a count gives 0. An output can combine them: `"share_low = count_if(glucose < 70) / count(*)"`, `"mean = round(avg(glucose), 1)"`.
- A NULL in arithmetic or a comparison gives NULL. Write `coalesce(x, 0)` or `x is null` when a missing value has a meaning.

## Other operators

The core operators cover tables. Python covers what SQL cannot say, such as a model fit, a statistic over each patient's rows, or a forecast: the `python-udf` skill. The classic operators remain for charts and the rest. `list_operators` with `q` naming one returns its settings as a JSON Schema, and a line sets them by the schema's names: `set chart: BarChart(lows, fields="patient_id", value="lows")`. A name with spaces is quoted: `"result attribute"="total"`. Never call `list_operators` without `q`: the registry is far too large to read. A chart draws on the execution's page; compute the numbers you report with the core operators.
