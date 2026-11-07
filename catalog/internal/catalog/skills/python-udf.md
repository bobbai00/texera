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
name: python-udf
description: Compute what SQL cannot with Python - the project's own functions as operators, writing a function with @returns that becomes one, by to spread whole groups over workers, functions that make rows from nothing or yield them as they go, a Credential setting for a secret, and the packages a computing unit brings.
---

# Python in a workflow

Use Python for what the core operators and their SQL cannot say: a statistic over each patient's rows, a model fit or a forecast, a test. Keep the selecting, joining and counting in core operators around it, so the Python gets only the rows and columns it needs.

## The project's functions first

A project keeps the Python it reuses as functions, each one of its operators. `search_resources` with kind `operator` and `project` set to the chat's project finds them; `get_resource` shows one's description, settings, output columns and code. A line calls one by its name, with its settings:

```
set metrics: cgm_metrics(night, by=["patient_id"], tir_low=70)
```

The answer's lines write it at its version, `texera://operators/<rid>@<version>(night, ...)`, so a later change to the function does not change this workflow until it is edited.

## A function of your own

Write it in the `python` of `create_workflow` or `edit_workflow`, as one module. Every top-level function under `@returns(...)` becomes one of the project's operators, a new version when its code changed, and the lines call it by name:

```python
import pandas as pd

@returns(patient_id=str, readings=int, time_below=float)
def overnight_lows(readings: pd.DataFrame, *, threshold: int = 70) -> pd.DataFrame:
    """Per patient: the readings and the share of them below a threshold."""
    g = readings.groupby("patient_id")["glucose"]
    return pd.DataFrame({
        "readings": g.size(),
        "time_below": g.apply(lambda s: (s < threshold).mean()),
    }).reset_index()
```

```
set lows: overnight_lows(night, by=["patient_id"], threshold=54)
```

- The positional parameters are its inputs, one DataFrame each, in the order the line names them. The parameters with defaults, or after `*`, are its settings; give each a type, `int`, `float`, `str`, `bool` or `list[str]`, or a default it can be read from. The docstring is the operator's description. A function without `@returns` is a helper the others may call.
- `@returns(name=type, ...)` declares every output column, in order: `str`, `int`, `float`, `bool` or `datetime`. The function returns a DataFrame with exactly those columns; a groupby's keys are in its index until `.reset_index()`. Other columns fail the run, naming what was declared and what came back.
- A later run reuses a function's rows when its code, settings and input are the same. A function that may give other rows for the same input, because it samples without a seed, reads the clock or calls out to a service, says `nondeterministic=True` in its `@returns(...)`; then every run makes its rows, and those of what follows it, again. A seeded sample (`df.sample(n=100, random_state=7)`) needs no mark.
- `by=["patient_id"]` sends the rows of each patient to one worker, whole, and each worker calls the function once on its share, which may hold many patients: group inside the function, as above. Without `by`, one worker gets every row, which is fine for a small table.
- The catalog refuses a function it cannot read, saying on which line of the python. An exception fails the run with a traceback that points at your line: fix the function and send the module again with `edit_workflow`; the workflow's calls move to the new version.

## Sources, streams and secrets

- A function with no positional parameter reads no table: it is a source, called once, as one that fetches from a service or generates rows. Its line names no input: `set trials: fetch_trials(query="type 1 diabetes", limit=50)`.
- A function may `yield` DataFrames as it makes them instead of returning one: each goes on as it comes, so what follows starts on it and the person sees rows arrive. Work row by row as one DataFrame expression (`rows.assign(ratio=rows.a / rows.b)`), or with the core `compute` operator's SQL, not a loop over rows.
- A setting typed `Credential` (`api_key: Credential`) names one of the project's credentials: the line gives its URI, `api_key="texera://credentials/<rid>"`, and the function gets the secret for the run, which no workflow or result keeps. `search_resources` with kind `credential` finds them. Never write a secret into code or a setting.
- Write functions, never classes. The classes that run a function (`UDFOperatorV2`, `process_tuple` and the like) and the operators that run code by itself (`PythonUDFV2`, `function`) are the engine's: the catalog refuses them in a workflow and as an operator's code.

## Packages

The deployment's unit has pandas, numpy and pyarrow. For another package, the workflow runs on a unit that has it: `search_resources` with kind `profile` finds a profile that lists it, `create_computing_unit` makes a unit from that profile, and `edit_workflow` with `defaultComputingUnit` set to the unit sends this run and every later one there, the person's own runs from the Run bar included. A new unit costs money: ask before you create one, and say which profile and why (the `computing-units` skill). If no profile has the package, ask the person to add it to a profile.
