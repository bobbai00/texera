// Texera 2.0 catalog contract.
//
// One envelope (apiVersion, kind, metadata, spec, status) carries every kind of resource.
// Every kind has a flat collection `/{plural}/{rid}`; executions are the one nested kind
// (`/workflows/{rid}/executions/{eid}`); versions, files, operators and ports, computing
// nodes and messages are subresources with their parent's permissions. Actions are POSTs on a
// verb subresource (`/{rid}/run`). The URI of a resource is `texera://` plus its path.
//
// Extensions the generators read (cmd/catalogen):
//   x-texera-kind        on an envelope model: kind, plural, versioned, content, parent, index
//   x-texera-permission  on every operation: the permission the caller needs
//   x-mcp                on an operation: the MCP tool it is exposed as, and on which server
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "@typespec/openapi3";
import "../common.tsp";
import "./core.tsp";
import "./resources.tsp";
import "./principals.tsp";
import "./kinds/project.tsp";
import "./kinds/workflow.tsp";
import "./kinds/execution.tsp";
import "./kinds/dataset.tsp";
import "./kinds/model.tsp";
import "./kinds/profile.tsp";
import "./kinds/computing-unit.tsp";
import "./kinds/warehouse.tsp";
import "./kinds/operator.tsp";
import "./kinds/agent-template.tsp";
import "./kinds/skill.tsp";
import "./kinds/mcp-server.tsp";
import "./kinds/conversation.tsp";
import "./kinds/credential.tsp";
import "./kinds/model-endpoint.tsp";
import "./kinds/settings.tsp";
import "./access.tsp";
import "./lineage.tsp";

using Http;
using Rest;
using OpenAPI;

@service(#{ title: "Texera Catalog" })
@info(#{ version: "2.0.0-alpha" })
@server("http://localhost:8088", "the gateway")
@useAuth(BearerAuth)
namespace Texera.Catalog;

@route("/catalog/v1")
namespace Routes {}
