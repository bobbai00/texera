import type { McpServerSpec, McpServerStatus } from "@texera/catalog-client/types";
import { Plug } from "lucide-react";
import type { KindSpec } from "../types";

export const mcpServerKind: KindSpec = {
  kind: "mcp-server",
  label: "MCP server",
  plural: "MCP servers",
  icon: Plug,
  accent: "bg-kind-mcp-server/12 text-kind-mcp-server",
  defaultSpec: () => ({ url: "" }) satisfies McpServerSpec,
  facts: r => {
    const spec = r.spec as Partial<McpServerSpec>;
    const status = r.status as McpServerStatus | undefined;
    const tools = status?.tools?.length;
    return [spec.url ?? "", ...(tools !== undefined ? [`${tools} tool${tools === 1 ? "" : "s"}`] : [])].filter(Boolean);
  },
};
