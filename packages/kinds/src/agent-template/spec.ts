import type { AgentTemplateSpec, Defaults } from "@texera/catalog-client/types";
import { Bot } from "lucide-react";
import { lazy } from "react";
import { resourceQuery } from "../queries";
import type { CreateInput, KindSpec } from "../types";
import { TemplateForm } from "./Form";

export const templateQuery = resourceQuery;

/** A fresh template: a card, the platform's model, the catalog tools, no skills yet. */
export const defaultTemplateSpec = ({ name, description }: CreateInput, defaults: Defaults): AgentTemplateSpec => ({
  card: { name, description: description ?? "" },
  model: defaults.modelEndpoint ?? "",
  prompt: `You are ${name}. Help the person with their work on Texera; find what they need in the catalog before answering.`,
  catalogTools: true,
});

export const agentTemplateKind: KindSpec = {
  kind: "agent-template",
  label: "Agent template",
  plural: "Agent templates",
  icon: Bot,
  accent: "bg-kind-agent-template/12 text-kind-agent-template",
  Card: lazy(() => import("./Card")),
  Editor: TemplateForm,
  prefetch: (qc, ref) => qc.prefetchQuery(templateQuery(ref.rid)),
  defaultSpec: defaultTemplateSpec,
  facts: r => {
    const spec = r.spec as Partial<AgentTemplateSpec>;
    const servers = spec.mcpServers?.length ?? 0;
    const skills = spec.skills?.length ?? 0;
    const handoffs = spec.handoffs?.length ?? 0;
    return [`${skills} skill${skills === 1 ? "" : "s"}`, `${servers} MCP server${servers === 1 ? "" : "s"}`, ...(handoffs ? [`hands off to ${handoffs}`] : [])];
  },
};
