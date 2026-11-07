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
description: Compute what SQL cannot with Python in a workflow line - the team's own Python operators, a PythonUDFV2 line with its code in triple quotes, the row, table and source interfaces, the columns it adds, and the packages a computing unit brings.
---

# Python in a workflow

Use Python for what the core operators and their SQL cannot say: a statistic over each patient's rows, a model fit or a forecast, a test. Keep the selecting, joining and counting in core operators around it, so the Python gets only the rows and columns it needs.

## The team's own operators first

A team keeps the Python it reuses as custom operators. `search_resources` with kind `operator` finds them in the chat's project; `get_resource` shows one's description, its code, its settings and the columns it adds. A line calls one by its type, with its settings, which its code reads as the dict `PROPS`:

```
set metrics: cgm_metrics(night, tir_low=70, tir_high=180)
```

The answer writes it at its version, `texera://operators/<rid>@<version>(night, ...)`, so later changes to the operator do not change this workflow.

## A Python line

`PythonUDFV2` runs code on its one input:

```
set ratio: PythonUDFV2(petals, code="""from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["ratio"] = tuple_["PetalLengthCm"] / tuple_["SepalLengthCm"]
        yield tuple_
""", outputColumns=[{"attributeName": "ratio", "attributeType": "double"}], retainInputColumns=true, workers=1, defaultEnv=true)
```

- `code`: the Python, in `"""..."""`, taken as it is.
- `outputColumns`: every column the code adds that its input lacks, with its type: `string`, `integer`, `long`, `double`, `boolean` or `timestamp`. With `retainInputColumns` `true` the output is the input's columns and then these; with `false`, only these. Always set both.
- `workers` `1` keeps row order and state simple.
- `defaultEnv` `true` runs with the packages of the unit it runs on.

## The interfaces

Row by row, one row in and zero or more out; a row reads and writes like a dict, by column name:

```python
from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        if tuple_["glucose"] is not None:
            tuple_["mmol"] = tuple_["glucose"] / 18.016
            yield tuple_
```

The whole input as a pandas DataFrame, for logic across rows; it runs once, after the last row:

```python
from pytexera import *
import pandas as pd

class ProcessTableOperator(UDFTableOperator):
    @overrides
    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        g = table.groupby("patient_id")["glucose"]
        yield pd.DataFrame({"mean": g.mean(), "cv": g.std() / g.mean()}).reset_index()
```

A `Table` is a pandas DataFrame; import pandas or numpy yourself. A table operator that returns new columns lists them all in `outputColumns`, with `retainInputColumns` `false`.

A source reads no input: `set rows: PythonUDFSourceV2(code="""...""", columns=[{"attributeName": "n", "attributeType": "integer"}], workers=1, defaultEnv=true)`, with `class GenerateOperator(UDFSourceOperator)` and `def produce(self) -> Iterator[Optional[Union[TupleLike, TableLike]]]`.

Rules: keep the class names above; no code at the top level besides imports and the class; yield nothing to drop a row; `logger.info(...)` writes to the operator's console. An exception fails the execution with a traceback that points at your line: fix the code with `edit_workflow` and run again. If the same error repeats, read the operator's input before you change the code again.

## Packages

The platform's units have pandas, numpy and pyarrow. For another package, the workflow runs on a unit that has it: `search_resources` with kind `profile` finds a profile that lists it, `create_computing_unit` makes a unit from that profile, and `edit_workflow` with `defaultComputingUnit` set to the unit sends this run and every later one there, the person's own runs from the Run bar included. A new unit costs money: ask before you create one, and say which profile and why (the `computing-units` skill). If no profile has the package, ask the person to add it to a profile.
