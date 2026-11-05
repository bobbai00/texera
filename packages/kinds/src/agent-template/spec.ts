import type { AgentTemplateSpec } from "@texera/catalog-client/types";
import { Bot } from "lucide-react";
import { lazy } from "react";
import { resourceQuery } from "../queries";
import type { KindSpec } from "../types";
import { TemplateForm } from "./Form";

/**
 * An agent: its card, prompt, model, skills and MCP servers, as a versioned resource. The
 * platform ships the one every chat runs, so the app shows agents and makes none (no
 * `defaultSpec`); the API still does.
 */
export const agentTemplateKind: KindSpec = {
  kind: "agent-template",
  label: "Agent",
  plural: "Agents",
  icon: Bot,
  accent: "bg-kind-agent-template/12 text-kind-agent-template",
  Card: lazy(() => import("./Card")),
  Editor: TemplateForm,
  prefetch: (qc, ref) => qc.prefetchQuery(resourceQuery(ref.rid)),
  facts: r => {
    const spec = r.spec as Partial<AgentTemplateSpec>;
    const servers = spec.mcpServers?.length ?? 0;
    const skills = spec.skills?.length ?? 0;
    const handoffs = spec.handoffs?.length ?? 0;
    return [`${skills} skill${skills === 1 ? "" : "s"}`, `${servers} MCP server${servers === 1 ? "" : "s"}`, ...(handoffs ? [`hands off to ${handoffs}`] : [])];
  },
};
