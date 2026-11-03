import { mcpServersCreate } from "@texera/catalog-client";
import { mcpServersReadOptions } from "@texera/catalog-client/query";
import type { McpServerSpec } from "@texera/catalog-client/types";
import { Plug } from "lucide-react";
import { lazy } from "react";
import { unwrap } from "../api";
import type { KindSpec } from "../types";

export const mcpServerQuery = (rid: string) => mcpServersReadOptions({ path: { rid } });

export const mcpServerKind: KindSpec = {
  kind: "mcp_server",
  label: "MCP server",
  plural: "MCP servers",
  slug: "m",
  librarySlug: "mcp-servers",
  icon: Plug,
  accent: "bg-kind-mcp_server/12 text-kind-mcp_server",
  Card: lazy(() => import("./Card")),
  View: lazy(() => import("./View")),
  prefetch: (qc, ref) => qc.prefetchQuery(mcpServerQuery(ref.rid)),
  create: async ({ name, description, project }) => {
    const spec: McpServerSpec = { transport: "streamable_http", url: "" };
    const s = await unwrap(mcpServersCreate({ body: { name, description, project, spec } }));
    return { kind: "mcp_server", rid: s.metadata.rid };
  },
  facts: r => {
    const spec = r.spec as Partial<McpServerSpec>;
    const tools = (r.status as { tools?: string[] } | undefined)?.tools?.length;
    return [spec.builtin ? "built-in" : (spec.transport ?? ""), ...(tools !== undefined ? [`${tools} tool${tools === 1 ? "" : "s"}`] : [])].filter(Boolean);
  },
};
