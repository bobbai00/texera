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
name: computing-units
description: Choose where a workflow runs - the units there are, the profiles a unit is made from (CPU, memory, GPU, Python packages), when to ask before making one, and how a workflow keeps the unit it needs.
---

# Computing units

A workflow compiles and runs on a computing unit: a node with CPU, memory, perhaps GPUs, and Python packages. A call goes to the unit it names, else to the workflow's `defaultComputingUnit`, else to its project's default unit, which the project may inherit from a project up its chain: Texera's is the deployment's own unit (`project_settings` says which). Name a unit in `validate_workflow` or `run_workflow` only when the person asks for one.

## What there is

- `list_computing_units`: the units the person can run on, with their status.
- `search_resources` with kind `profile`: the profiles units are made from, Texera's ladder among them: Small, Medium and Large for data work, ML for models on CPU, GPU for training and fast inference. Each shows its `cpu`, `memory`, `gpu` and `packages`, and its `status` says whether this deployment can start it (`startable`) and if not why (`notHere`, such as "no GPU in this cluster"). Offer only what can start here, and when what the work needs cannot, say so and offer the nearest that can: ML on CPU for a GPU.

The deployment's unit runs the core operators and Python with pandas, numpy and pyarrow, and it is enough for most tables. A workflow needs another unit when its Python imports a package the deployment's unit lacks, such as scikit-learn, statsmodels or torch, or when its data or model needs more memory or a GPU. Never make a unit for work the deployment's unit can do.

## Ask first

A unit costs money while it runs and takes minutes to start, so the person chooses. Before `create_computing_unit`, call `ask` with the choices that make sense, each with what it gives and costs, for example:

- Run on the deployment's unit, which lacks scikit-learn: fit the model another way.
- Make a unit from "ML" (2 CPU, 8 GiB, scikit-learn): ready in a few minutes.
- Make a unit from "ML GPU" (1 GPU): faster to train, and costs more.

A GPU is always the person's choice, never yours. A ready unit made for the same purpose is reused rather than made again: look at `list_computing_units` first.

## Make it and keep it

1. `create_computing_unit` with a `name` that says what it is for, the `profile` URI (with `@version` to pin one), and `waitSeconds` 300: it answers once the unit is ready, or has failed. A run on a pending unit is refused.
2. `edit_workflow` with `defaultComputingUnit` set to the unit's URI, so this run and every later one go there, the person's own runs from the Run bar included.
3. Say which unit you made, from which profile, and why.

`save_unit_as_profile` keeps a unit's packages, pinned to the versions installed, as a profile others can make units from: a new one (`name`), or the next version of one (`profile`). Save one only when the person asks.
