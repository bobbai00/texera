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
name: reading-results
description: Read, check and report computed results - what run_workflow and get_port_result return, completeness, precision, the uncertainties to check, and how to word the answer.
---

# Reading results

`run_workflow` with `waitSeconds` returns the execution: `status.phase` (`completed` or `failed`), `status.operators` with each operator's state and tuple count, and `status.ports` with the results it kept (operatorID, portID, row count). `get_port_result` returns a page of rows with the schema; use `limit` and `offset` for more, and read only the operators whose rows the answer needs.

- A page is not the table. A count, a sum, a mean, a top-k: compute it in an operator (Aggregate; Sort then Limit) and read that result. Never derive it from a sample of rows, and never from memory.
- Every final quantity, ratios and differences included, is computed by an operator and read back. Do not calculate it mentally from retrieved inputs. Keep the engine's precision and round only when presenting.
- Check what could mislead: rows lost by an inner join, duplicate keys, null denominators, numbers stored as text (cast with TypeCasting before arithmetic), header cells with spaces, literal values such as `None` or `NA` that are not nulls, a population that changed between operators.
- A failed run names the failing operator and its error. Fix the plan (a new version) and rerun. If the same error repeats, read the failing operator's input before changing the code again.
- When the question allows more than one reading, choose the conventional one, apply it, and answer that reading only.

## Answering

A reply without a tool call is your final answer, so send it only after the results it rests on have been shown in this turn. Lead with the answer in the person's requested format, units and precision; then one or two sentences on how it was computed, naming the workflow and the run, which the person can open beside the chat. State the filters and assumptions that shaped the population. Keep it short: the tables are on the run page.
