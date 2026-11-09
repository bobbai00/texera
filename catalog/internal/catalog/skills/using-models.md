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
name: using-models
description: Use the team's models in a workflow - finding them, reading a version's contract (what it reads, what it puts out, what it needs), running it with predict, and checking what it says against what is known.
---

# Using models

A model is versions of files, like a dataset, and each version has a contract: what it reads and what it puts out. `predict` runs a version on a workflow's rows.

## Find and read

1. `search_resources` with kind `model` and `project` set to the chat's project lists the team's models. `get_resource` on one says its framework and task, and its newest version.
2. `get_version` on `texera://models/<rid>@<version>` returns the version's files and its `contract`:
   - `framework`: `sklearn`, a fitted estimator, or `python`, an entry file with `load(directory)` and `predict(model, frame)`.
   - `inputs`: the columns it reads, by exact name and type, in order.
   - `outputs`: the columns it adds. For an sklearn classifier, the predicted class, then the probability of its last class, the positive one of two.
   - `needs`: what it needs to run well, such as a GPU; `grouped`: it reads whole groups, such as one patient's readings, and needs `by`.
3. `list_dataset_files` and `read_dataset_file` read a model version's files too, by the model's rid: its `README.md`, the model card, says how it was fitted and evaluated and how it reads missing values, and a file such as `holdout.csv` lists the rows it was not fitted on. Read the card before you report on a model, and evaluate it on the rows it never saw, which a line reads as `scan(file="<model name>/holdout.csv")`.
4. `get_lineage` on the version shows what it was made from, such as the dataset version it was fitted on: say so when it matters, such as scoring the very rows a model was fitted on.

## Which model fits

When a person asks which of the team's models suits some data, read the data's columns and first rows and each model's contract and card, then say it in your own words before anything else, and before you ask where anything runs: what the data holds, the model you pick, and why, column by column and by who the model is for and what it predicts; and in a line each, why the others do not fit. Write that out: a person reads it to decide, and a name alone is not an answer. If the person wants it applied, go on from there: asking where it runs comes next.

## Run it

```
set cohort: scan(file="Pima cohort/diabetes.csv")
set scored: predict(cohort, model="Diabetes risk@2")
set calibration: aggregate(scored, by=["predicted"], outputs=["n = count(*)", "observed = avg(Outcome)", "mean_risk = avg(risk)"])
```

- `model` names the model by its name, at the newest version or the one `@n` pins, or by its URI with `@version`. The answer's lines show the URI at the version used, and the execution records that it used that version.
- The input must have every column the model reads, by its exact name, and numbers where it reads numbers. A mismatch is an error on the line before anything runs: rename with `project`, or convert in `compute`. A missing value is passed to the model as it is, and many models refuse one: filter the rows first, or fill them in a `compute`, and say which you did.
- The outputs are added to every row; for a grouped model, the output is one row per group, its keys then its outputs, and the line needs `by`.
- Before a model's first run in a chat, however small the data, unless the person already said where, load the `computing-units` skill and `ask` where it runs, with these choices: a unit already made here and ready, by its name, first; the Public unit (shared, ready now); Small (2 CPUs, 4 GB), Medium (4 CPUs, 8 GB) and Large (8 CPUs, 16 GB), each a new unit of the person's own, and GPU only when a GPU profile can start here; when none can, say in the question that this deployment has no GPU. Leave out a profile whose `status` says it cannot start. A model whose `needs` names a GPU or much memory should run on a unit that has it.

## Check what it says

A model's output is an estimate. Report it with a check from the same workflow: against a known outcome when the data has one (the share predicted correctly, the observed rate in each band of risk), else its distribution (its mean and range). When the data has the outcome, look for the project's own operators first, `search_resources` with kind `operator` and `project`: a team's ROC AUC or calibration operator is how the team measures a model, and comes before an aggregate of your own. Say which version made the numbers.
