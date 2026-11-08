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
name: exploring-resources
description: Answer what a project holds and what could be done with it - surveying its datasets, models, operators, workflows and executions, reading their descriptions, files, versions and lineage, and proposing analyses that rest on them.
---

# What the team has

A person new to a project asks what is in it, what it can answer, and where to start. Answer from what the catalog returns, kind by kind, never from what such a project usually holds.

## Survey

1. `search_resources` once per kind, with `project` set to the chat's project so that only the team's own resources come back, not what it inherits from the projects up its chain (Texera's operators and profiles among them): `dataset`, `model`, `operator`, `workflow`, then `execution` for what has been run. Add `q` with a word from the question, such as `glucose`, to narrow a long list.
2. Read what each says of itself: its name, its description and its labels. `get_resource` returns the rest: a model's framework and task, a custom operator's settings, the columns it adds and its code, a workflow's head version.
3. Look inside the data that matters to the question: `list_dataset_files` for a dataset version's files, and `read_dataset_file` for a file's header and first rows. A file's columns, units and coding, such as glucose in mg/dL or mmol/L or an outcome coded 0 and 1, decide what can be computed from it.
4. Follow how things were made: `get_lineage` on a model, a dataset or a workflow shows what it was made from and what was made from it, and `list_versions` shows how it changed.

## What the platform offers

Asked what tools there are, answer beyond the team's own resources, from what the catalog returns:

- `list_operators`: the operator types the project can use, its own and those it inherits from Texera, by group; name the groups and a few operators of each that fit the person's field, and the team's own Python operators by name.
- `search_resources` with kind `model`: the models a workflow can run with `predict`, each with what it reads and predicts.
- `search_resources` with kind `profile`: where work can run, the sizes and whether a GPU can start here (each profile's `status`).
- `search_resources` with kind `mcp-server`: the outside sources you can read, such as PubMed.
- Data from the internet can come into a dataset: the catalog fetches a file at a public URL (the importing-data skill).

## Answer

- Group what is there by kind, one line each: the name, what it holds or does in a few words, its newest version, and the URI chip, so the person can open it.
- Say what it can answer: two or three analyses the resources support together, each naming the resources it would use and the question it settles. Point out a gap honestly, such as a model without a test set, or two datasets without a shared key.
- Stop there. A survey changes nothing; the person picks what to do next. When they pick, plan the work and start it.
