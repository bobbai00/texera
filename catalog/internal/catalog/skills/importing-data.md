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
name: importing-data
description: Bring data from the internet into a dataset - the file's URL, making the dataset, having the catalog fetch the file, committing with its source, and checking what came in.
---

# Bringing data in

A person asks for data the project does not have: a public cohort, a reference table, a file at a URL they name. The catalog fetches it itself into a dataset, so the bytes never pass through the chat.

## Where it comes from

Use the URL the person gives. When they name data without a URL, say which source you would fetch from (the publisher's own download, or a stable copy such as a raw file in a public repository) and what its licence allows, and ask before fetching. Only an https file on the public internet comes in, and a page about the data is not the data: fetch the file itself, a CSV, TSV, JSON or Parquet file.

## Bring it in

1. `start_work`, naming the dataset you will make or add to.
2. `create_dataset` with a name that says what it holds, a description with its source, its licence and what one row is, and the format (`csv`). To add a file to a dataset the project has, use that one instead.
3. `import_dataset_file` with the dataset's `rid` and the `url`; give `path` when the URL's own file name says little.
4. `commit_dataset_version` with a message that says where it came from, such as "Pima Indians Diabetes (NIDDK), from https://...".
5. `read_dataset_file` on the new version with a few thousand bytes: the header and the first rows. Say how many columns there are, what they hold, and anything to watch for, such as a 0 that stands for a measurement not taken.

A refusal says why: an address not on the public internet, a file over the deployment's limit, a server that answered 404. Say so plainly, and do not look for a way around it.

## After

Give the dataset's URI chip, and the file URI a workflow reads it by: `texera://datasets/<rid>@<vno>/files/<path>`.
