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

<h1 align="center">Apache Texera - Human-AI Collaborative Data Science Using Visual Workflows</h1>

<p align="center">
  <a href="https://texera.io"> <img src="frontend-next/public/texera-logo.png" alt="texera-logo" height="150px"/> </a>
  <br>
  <i>Apache Texera (Incubating) is an open-source platform for human-AI collaborative data science using visual workflows.</i>
  <br>
  
  <h4 align="center">
    <a href="https://texera.apache.org/">Official Site</a>
    |
    <a href="https://texera.io/category/video/">Video</a>
    |
    <a href="https://texera.io/publications/">Publications</a>
    | 
    <a href="https://texera.io/category/blog/">Blog</a>
    <br>
  </h4>
  
</p>
</p>
<p align="center">
  <img alt="Static Badge" src="https://img.shields.io/badge/Users-332-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Projects-86-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Workflows-2,481-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Executions-51K-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Workflow_Versions-357K-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Deployments-7-blue">
  <img alt="Static Badge" src="https://img.shields.io/badge/Largest_Deployment-100_nodes,_400_cores-green">
  <a href="https://app.codecov.io/gh/apache/texera"><img alt="Coverage" src="https://img.shields.io/codecov/c/github/apache/texera/main?logo=codecov&label=coverage"></a>
</p>

Apache Texera (Incubating) is an open-source platform for human-AI collaborative data science using visual workflows. It enables human analysts to construct, execute, and refine data analysis tasks through an intuitive GUI, assisted by AI agents that understand natural-language instructions. Texera is well suited for a wide range of applications, including “AI for Science,” by making advanced AI and data science capabilities accessible to a broader community. It can run on a laptop for local use or be deployed in the cloud to support scalable processing of large datasets.

The platform has the following key features:

* Natural-language data science through AI agents 
* Intuitive GUI-based workflows for data science
* Real-time collaboration for workflow editing and execution
* Runtime debugging and interactive workflow execution
* Language-agnostic workflow runtime, native support for Python and Java
* Parallel backend engine for scalable big-data processing
* Separation of compute and storage for flexible cloud deployment


![texera-screenshot](docs/system-screenshot.png)

# Texera 2.0 (this branch)

This branch reorganizes Texera around chat-first data analysis: people ask an agent, the agent
builds and runs workflows through the Texera MCP server, and every resource it creates or changes
is versioned, attributed to the agent on the person's behalf, and linked by lineage.

| Path | What it is |
|---|---|
| `api/` | The TypeSpec contract; `make generate` emits OpenAPI, the Go server, the TypeScript client and the MCP tool table |
| `catalog/` | The Go control plane: resources and versions, grants and the policy decision point, executions and lineage, datasets, computing units, environments, the MCP server |
| `agent-runtime/` | The agent runtime (Vercel AI SDK 7): AG-UI chat streams, agent templates, pluggable MCP servers |
| `amber/` | The computing unit: Amber as a pure workflow engine that reports runs back as OpenLineage events |
| `frontend-next/`, `packages/` | The React app and its shared packages |
| `common/` | Engine libraries: workflow core, operators, compiler, config, auth |
| `bin/texera-2-0/` | The dev stack: `up.sh`, `test.sh`, `down.sh` (see its README) |
| `docs/texera-2-0/` | The plan and the progress log |


# Citation
Please cite Texera as 
```

@article{DBLP:journals/pvldb/WangHNKALLDL24,
  author       = {Zuozhi Wang and
                  Yicong Huang and
                  Shengquan Ni and
                  Avinash Kumar and
                  Sadeem Alsudais and
                  Xiaozhen Liu and
                  Xinyuan Lin and
                  Yunyan Ding and
                  Chen Li},
  title        = {Texera: {A} System for Collaborative and Interactive Data Analytics
                  Using Workflows},
  journal      = {Proc. {VLDB} Endow.},
  volume       = {17},
  number       = {11},
  pages        = {3580--3588},
  year         = {2024},
  url          = {https://www.vldb.org/pvldb/vol17/p3580-wang.pdf},
  timestamp    = {Thu, 19 Sep 2024 13:09:37 +0200},
  biburl       = {https://dblp.org/rec/journals/pvldb/WangHNKALLDL24.bib},
  bibsource    = {dblp computer science bibliography, https://dblp.org}
}
```
