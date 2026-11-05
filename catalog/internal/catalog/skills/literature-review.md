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
name: literature-review
description: Ground biomedical research ideas in the literature with the bio tools - how to search PubMed well, follow citations, look up genes, variants and proteins, and cite what you found.
---

# Literature review with the bio tools

The bio MCP server answers from public sources: PubMed (`search_pubmed`, `get_citation_network`), NCBI Gene (`search_genes`), dbSNP and ClinVar (`lookup_variant`, `interpret_clinical_variant`), UniProt (`search_proteins`). Every claim you make about prior work should trace to a result one of these tools returned in this turn.

## Searching PubMed

- Start from the person's question, not from your memory: run `search_pubmed` with two or three different queries (the mechanism, the disease, the method), `limit` 10 to 20, `sort` `relevance`; add `publication_date_start` for recent work when the person asks for the state of the art.
- Use MeSH-like phrasing and boolean operators: `"CRISPR off-target" AND (detection OR prediction)`; put multi-word terms in quotes.
- `get_citation_network` on the one or two most relevant PMIDs finds what they cite and what cites them; it is the fastest way to reach the key papers of a subfield.
- Read the abstracts the tool returns before you summarize; a title is not a finding.

## Genes, variants, proteins

- `search_genes` with a symbol (`BRCA1`) or a name; it returns identifiers, aliases and summaries.
- `lookup_variant` with an rs id or `chr:pos:ref:alt`; `interpret_clinical_variant` adds the ClinVar significance.
- `search_proteins` with a protein or gene name for UniProt entries, functions and domains.

## Answering

Give research ideas as a short numbered list. For each idea: one sentence on the gap, one on what to do, and the papers that motivate it, cited as "Author et al., Journal, Year (PMID 12345678)" with the PubMed link `https://pubmed.ncbi.nlm.nih.gov/12345678/`. Say what the literature does not settle. When the person wants to analyze their own data, do not guess at numbers: load texera-workflows, then build and run a workflow on the dataset.
