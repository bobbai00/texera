// Who is calling, who can be shared with, and the caller's preferences.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";
import "./core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model Me {
  principal: Principal;
  @doc("The caller's personal project, created at first login.")
  homeProject: Rid;
  @doc("The project that holds the platform's built-in resources.")
  systemProject: Rid;
  @doc("Whether the caller is a platform administrator.")
  admin: boolean;
  preferences: Record<unknown>;
}

model PrincipalPage is Page<Principal>;

namespace Routes {
  @route("/me")
  interface Me {
    @doc("The calling principal, its projects and preferences; creates the principal and its home project on first login.")
    @get
    @extension("x-texera-permission", "self")
    @extension("x-mcp", #{
      server: "catalog",
      tool: "whoami",
      description: "Who am I: the calling principal, the home project and the system project.",
      readOnlyHint: true,
    })
    get(): Texera.Catalog.Me | Error;

    @doc("Replace the caller's preferences, a free-form document the app owns.")
    @put
    @route("/preferences")
    @extension("x-texera-permission", "self")
    updatePreferences(@body body: Record<unknown>): Record<unknown> | Error;
  }

  @route("/principals")
  interface Principals {
    @doc("Search the principals known to the catalog (everyone who has logged in, and groups), for sharing.")
    @get
    @extension("x-texera-permission", "self")
    @extension("x-mcp", #{
      server: "catalog",
      tool: "search_principals",
      description: "Find users and groups by name or email, to share resources with.",
      readOnlyHint: true,
    })
    list(@query q?: string, @query kind?: PrincipalKind, @query limit?: int32): Ok<PrincipalPage> | Error;

    @get
    @route("/{pid}")
    @extension("x-texera-permission", "self")
    read(@path pid: Pid): Principal | Error;
  }
}
