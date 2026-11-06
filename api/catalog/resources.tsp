// The generic routes: every kind through one untyped envelope, plus what every kind shares
// (versions, grants, lineage, dependents) under /resources so no kind repeats them.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";
import "./core.tsp";
import "./lineage.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model ResourcePage is Page<Resource>;

@doc("A stream of server-sent events; each `data:` line is JSON: a Resource for `resource`, a Message for `message`, `{rid}` for `deleted`.")
model WatchStream {
  @statusCode statusCode: 200;
  @header contentType: "text/event-stream";
  @body body: string;
}
model VersionSummaryPage is Page<VersionSummary>;

@doc("A URI resolved to what it names.")
model Resolved {
  resource: Resource;
  @doc("Present when the URI carried `@vno`.")
  version?: Version;
  @doc("The subresource path after the resource, when the URI carried one, e.g. `files/iris.csv`.")
  subresource?: string;
}

namespace Routes {
  @route("/resources")
  interface Resources {
    @doc("Search the resources the caller may read, across kinds.")
    @get
    @extension("x-texera-permission", "list")
    @extension("x-mcp", #{
      tool: "search_resources",
      description: "Search the catalog for resources the caller can read: workflows, datasets, executions, agent templates, skills, MCP servers, computing units, profiles, operators, conversations. Filter by kind or text. In a chat a search covers the chat's project and the built-ins; pass scope to look in another project (kind project lists them all). Pass shared=true for what other people shared with the person.",
      readOnlyHint: true,
    })
    search(
      ...Scoped,
      @query q?: string,
      @query kind?: ResourceKind,
      @query parent?: Rid,
      @query project?: Rid,
      @query origin?: Rid,
      @doc("Only what others shared with the caller: resources they hold a grant on and do not own, in whatever project.")
      @query shared?: boolean,
      @query limit?: int32,
      @query cursor?: string,
    ): Ok<ResourcePage> | Error;

    @doc("Resolve a `texera://` URI to its resource, version and subresource path.")
    @get
    @route("/resolve")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "resolve_uri",
      description: "Resolve a texera:// URI (optionally with @vno and a subresource path) to the resource it names, with its metadata and spec.",
      readOnlyHint: true,
    })
    resolve(@query uri: Uri): Resolved | Error;

    @get
    @route("/{rid}")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_resource",
      description: "Get one resource by rid: its kind, metadata, head version number, spec and status.",
      readOnlyHint: true,
    })
    read(@path rid: Rid): Resource | Error;

    @doc("Watch a resource: server-sent events for as long as the connection stays open. `resource` carries the resource after each change (its status included), `message` a message of a conversation as it is appended or rewritten, `deleted` ends the stream. It opens with the resource as it stands and, for a conversation, the messages after `after`, so a client that listed first misses nothing. A comment line every few seconds keeps the connection alive.")
    @get
    @route("/{rid}/events")
    @extension("x-texera-permission", "read")
    watch(@path rid: Rid, @query after?: int64): WatchStream | Error;

    @patch
    @route("/{rid}")
    @extension("x-texera-permission", "write")
    updateMetadata(@path rid: Rid, @header("If-Match") ifMatch?: string, @body body: UpdateMetadata): Resource | Error;

    @delete
    @route("/{rid}")
    @extension("x-texera-permission", "delete")
    delete(@path rid: Rid): void | Error;

    @get
    @route("/{rid}/versions")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "list_versions",
      description: "List the versions of a resource, newest first, with their digests and messages.",
      readOnlyHint: true,
    })
    listVersions(@path rid: Rid, @query limit?: int32, @query cursor?: string): Ok<VersionSummaryPage> | Error;

    @get
    @route("/{rid}/versions/{vno}")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_version",
      description: "Get one version of a resource with its full content.",
      readOnlyHint: true,
    })
    readVersion(@path rid: Rid, @path vno: Vno): Version | Error;

    @doc("Walk the lineage graph from a resource or one of its versions.")
    @get
    @route("/{rid}/lineage")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "get_lineage",
      description: "Get the lineage of a resource or version: what it was derived from, which executions used or produced it, upstream and downstream.",
      readOnlyHint: true,
    })
    lineage(
      @path rid: Rid,
      @query vno?: Vno,
      @query direction?: LineageDirection,
      @query depth?: int32,
    ): LineageGraph | Error;

    @doc("The resources whose specs reference this one.")
    @get
    @route("/{rid}/dependents")
    @extension("x-texera-permission", "read")
    dependents(@path rid: Rid, @query vno?: Vno): Edge[] | Error;

    @doc("The live document of a resource, for the platform's live service.")
    @get
    @route("/{rid}/live")
    @extension("x-texera-permission", "service")
    readLive(@path rid: Rid): LiveState | Error;

    @doc("Keeps the live document of a resource, for the platform's live service.")
    @put
    @route("/{rid}/live")
    @extension("x-texera-permission", "service")
    writeLive(@path rid: Rid, @body body: LiveState): void | Error;

    @get
    @route("/{rid}/grants")
    @extension("x-texera-permission", "share")
    listGrants(@path rid: Rid): Grant[] | Error;

    @put
    @route("/{rid}/grants/{pid}")
    @extension("x-texera-permission", "share")
    @extension("x-mcp", #{
      tool: "grant_access",
      description: "Share a resource with a principal: give a user or group a relation (viewer, editor, owner; user for a computing unit). Find principals with search_principals.",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
    grant(@path rid: Rid, @path pid: Pid, @body body: GrantRequest): Grant | Error;

    @delete
    @route("/{rid}/grants/{pid}")
    @extension("x-texera-permission", "share")
    revoke(@path rid: Rid, @path pid: Pid): void | Error;
  }
}
