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
description: Compute what the built-in operators cannot with a PythonUDFV2 operator - the pytexera interface (tuple, table and source operators), extra output columns, pandas, and Environments for extra packages.
---

# Python UDF operators

`PythonUDFV2` runs your Python on every row (or the whole table) of its one input and emits rows on `output-0`:

```json
{"operatorID": "udf", "operatorType": "PythonUDFV2", "viewResult": true,
 "operatorProperties": {"code": "<python>", "workers": 1, "retainInputColumns": true, "defaultEnv": true,
                        "outputColumns": [{"attributeName": "score", "attributeType": "double"}]},
 "inputPorts": [{"portID": "input-0"}], "outputPorts": [{"portID": "output-0"}]}
```

- `outputColumns` declares every column the code adds that the input lacks (`string`, `integer`, `long`, `double`, `boolean`, `timestamp`); with `retainInputColumns` `true` the output is the input columns plus these.
- `workers` `1` keeps row order and state simple.
- `defaultEnv` `true` runs in the unit's environment (pandas, numpy, pyarrow). For other packages, run the workflow with an Environment resource that lists them (`run_workflow`'s `environment`) and keep `defaultEnv` `true`.

## Code

Row by row (one row in, zero or more rows out). A tuple is read and written like a dict by column name:

```python
from pytexera import *

class ProcessTupleOperator(UDFOperatorV2):
    @overrides
    def process_tuple(self, tuple_: Tuple, port: int) -> Iterator[Optional[TupleLike]]:
        tuple_["score"] = float(tuple_["PetalLengthCm"]) / float(tuple_["SepalLengthCm"])
        yield tuple_
```

The whole table as a pandas DataFrame, for cross-row logic:

```python
from pytexera import *

class ProcessTableOperator(UDFTableOperator):
    @overrides
    def process_table(self, table: Table, port: int) -> Iterator[Optional[TableLike]]:
        table["rank"] = table["PetalLengthCm"].rank(method="min").astype(int)
        yield table
```

A source without input (`operatorType` `PythonUDFSourceV2`, no input port): `class GenerateOperator(UDFSourceOperator)` with `def produce(self) -> Iterator[Optional[Union[TupleLike, TableLike]]]`.

Rules: keep the class names above; no top-level code besides imports and the class; yield nothing to drop a row; `logger.info(...)` writes to the operator's console. An exception fails the run with a traceback that points at your line: fix the code (a new workflow version) and rerun.
