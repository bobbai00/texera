// mcp-server: an MCP server an agent can mount, over streamable HTTP. The platform's own
// servers (catalog, dataflow, scholar) are rows in the system project like any other.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model McpServerSpec {
  @doc("The server URL (streamable HTTP).")
  url: string;
  @doc("Headers sent on every request. A value `credential:<uri>` is replaced by that credential's leased secret; a value `credential:<uri>#<field>` by one field of it.")
  headers?: Record<string>;
  @doc("Set for a server the platform provides: catalog, dataflow or scholar. The runtime sends the person's token to a built-in server.")
  builtin?: string;
}

model McpServerStatus {
  @doc("Tool names discovered at the last check.")
  tools?: string[];
  reachable?: boolean;
  lastChecked?: utcDateTime;
}

@extension("x-texera-kind", #{ kind: "mcp-server", plural: "mcp-servers", versioned: true, content: "spec", parent: "project" })
model McpServer is Typed<McpServerSpec, McpServerStatus>;
model McpServerPage is Page<McpServer>;
model CreateMcpServer is Create<McpServerSpec>;
model UpdateMcpServer is UpdateSpec<McpServerSpec>;
model McpServerVersion is TypedVersion<McpServerSpec>;
model McpServerVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/mcp-servers")
  interface McpServers
    extends VersionedKindRoutes<McpServer, McpServerPage, CreateMcpServer, UpdateMcpServer, McpServerVersion, McpServerVersionPage> {}
}
