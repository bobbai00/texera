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
- Where a profile's `status` says `sized: false`, as on a deployment without a cluster, a unit made from it is the deployment's own unit with the profile's packages: it has the packages, not the profile's size. Say so when you offer it.

The deployment's unit runs the core operators and Python with the packages its profile lists (`list_computing_units` shows them), and it is enough for most tables. A workflow needs another unit when its Python imports a package the deployment's unit lacks, such as statsmodels or torch, or when its data or model needs more memory or a GPU. Never make a unit the person did not choose.

## Ask first

A unit of the person's own costs money while it runs and takes minutes to start, so where heavier work runs is the person's choice. Before the first run in a chat of work that runs a model (`predict`), fits one, or reads a large table, unless the person already said where, call `ask` with the choices that make sense here, each with what it gives and costs:

- The deployment's unit: shared, ready now, enough for small tables and light models.
- A unit of their own from each profile that fits and can start here, by name and size, for example Small (2 CPUs, 4 GB) and Large (8 CPUs, 16 GB): a few minutes to start on a cluster.
- A GPU only when a GPU profile can start here. When none can, say in the question that this deployment has no GPU, and offer ML on CPU instead where a model needs one.

Read the profiles' `status` first and offer nothing that cannot start. A GPU is always the person's choice, never yours. A ready unit made for the same purpose is reused rather than made again: look at `list_computing_units` first. Work the deployment's unit does well needs no question: run it there.

## Make it and keep it

1. `create_computing_unit` with a `name` that says what it is for, the `profile` URI (with `@version` to pin one), and `waitSeconds` 300: it answers once the unit is ready, or has failed. A run on a pending unit is refused.
2. `edit_workflow` with `defaultComputingUnit` set to the unit's URI, so this run and every later one go there, the person's own runs from the Run bar included.
3. Say which unit you made, from which profile, and why.

`save_unit_as_profile` keeps a unit's packages, pinned to the versions installed, as a profile others can make units from: a new one (`name`), or the next version of one (`profile`). Save one only when the person asks.
