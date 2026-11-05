// The registry: the single place that maps a kind to code. Adding a kind is one module
// under kinds/ and one line here; the contract's facts about it come from the kind table.

import { agentTemplateKind } from "./agent-template/spec";
import { computingUnitKind } from "./kinds/computing-unit";
import { conversationKind } from "./kinds/conversation";
import { credentialKind } from "./kinds/credential";
import { datasetKind } from "./kinds/dataset";
import { environmentKind } from "./kinds/environment";
import { executionKind } from "./execution/spec";
import { mcpServerKind } from "./kinds/mcp-server";
import { modelKind } from "./kinds/model";
import { modelEndpointKind } from "./kinds/model-endpoint";
import { operatorKind } from "./kinds/operator";
import { projectKind } from "./kinds/project";
import { settingsKind } from "./kinds/settings";
import { skillKind } from "./kinds/skill";
import type { KindId, KindSpec } from "./types";
import { workflowKind } from "./workflow/spec";

export const KINDS: Record<KindId, KindSpec> = {
  project: projectKind,
  workflow: workflowKind,
  execution: executionKind,
  dataset: datasetKind,
  model: modelKind,
  environment: environmentKind,
  "computing-unit": computingUnitKind,
  operator: operatorKind,
  "agent-template": agentTemplateKind,
  skill: skillKind,
  "mcp-server": mcpServerKind,
  conversation: conversationKind,
  credential: credentialKind,
  "model-endpoint": modelEndpointKind,
  settings: settingsKind,
};

/**
 * The sidebar's sections, in order. Each entry is a view, not a place: what a person makes and
 * keeps (Work), what happened (Activity: an execution lives under its workflow, and is listed
 * here because people look for one across workflows), what the agent is made of (Agent), and
 * the projects themselves.
 */
export const LIBRARY_GROUPS: { title: string; kinds: KindId[] }[] = [
  { title: "Work", kinds: ["workflow", "dataset", "model", "operator", "environment", "computing-unit"] },
  { title: "Activity", kinds: ["execution"] },
  { title: "Agent", kinds: ["agent-template", "skill", "mcp-server", "model-endpoint", "credential"] },
  { title: "Projects", kinds: ["project"] },
];

export const isKindId = (value: string): value is KindId => value in KINDS;
