import { agentTemplatesCreate } from "@texera/catalog-client";
import { agentTemplatesReadOptions } from "@texera/catalog-client/query";
import type { AgentTemplateSpec } from "@texera/catalog-client/types";
import { Bot } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const templateQuery = (rid: string) => agentTemplatesReadOptions({ path: { rid } });

/** A fresh template: a card, the built-in Texera tools, no skills yet. */
export const defaultTemplateSpec = (name: string, description?: string): AgentTemplateSpec => ({
  card: { name, description: description ?? "" },
  prompts: { system: "", objective: "" },
  skills: [],
  tools: { mcp: [] },
  subagents: { templates: [], maxConcurrent: 2, maxDepth: 1, lifetime: "conversation" },
});

export const agentTemplateKind: KindSpec = {
  kind: "agent_template",
  label: "Agent template",
  plural: "Agent templates",
  slug: "t",
  librarySlug: "templates",
  icon: Bot,
  accent: "bg-kind-agent_template/12 text-kind-agent_template",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(templateQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const t = await unwrap(agentTemplatesCreate({ body: { name, description, project, spec: defaultTemplateSpec(name, description) } }));
    return { kind: "agent_template", rid: t.metadata.rid };
  },
  facts: r => {
    const spec = r.spec as Partial<AgentTemplateSpec>;
    const mcp = spec.tools?.mcp?.length ?? 0;
    const skills = spec.skills?.length ?? 0;
    return [spec.model?.name ?? "default model", `${mcp} MCP server${mcp === 1 ? "" : "s"}`, `${skills} skill${skills === 1 ? "" : "s"}`];
  },
};
