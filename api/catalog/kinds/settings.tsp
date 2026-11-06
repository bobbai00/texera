// settings: the deployment's one configuration resource. Administrators write it; the public
// projection is served without a token so the app can brand its login page.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model Branding {
  name: string;
  logoUrl?: string;
}

model Defaults {
  @doc("The template a new chat starts with when the project names none.")
  agentTemplate?: Uri;
  computingUnit?: Uri;
  @doc("The profile a new computing unit is made from unless another is chosen.")
  profile?: Uri;
  @doc("The warehouse an execution keeps its results in when nothing else names one.")
  warehouse?: Uri;
  modelEndpoint?: Uri;
}

@doc("How long the catalog keeps what executions and uploads leave behind, as ISO 8601 durations (`P30D`, `PT12H`).")
model Retention {
  @doc("Finished executions keep their result tables this long; absent: forever. An execution's record and its summaries stay.")
  results?: duration;
  @doc("An uploaded file that no version and no staging names is removed this long after its upload; absent: one day.")
  blobs?: duration;
}

model SettingsSpec {
  branding: Branding;
  defaults: Defaults;
  features?: Record<boolean>;
  retention?: Retention;
  @doc("The object stores, by endpoint, a warehouse of someone's own may be kept on besides the deployment's own store. The lake and the computing units connect to the address a warehouse names, so an administrator lists them.")
  warehouseEndpoints?: string[];
}

@doc("What one retention sweep did.")
model RetentionSweep {
  executionsExpired: int32;
  blobsDeleted: int32;
}

model SettingsStatus {}

model AuthSettings {
  issuer: string;
  clientId: string;
}

@doc("What the app needs before anyone has logged in.")
model PublicSettings {
  branding: Branding;
  auth: AuthSettings;
}

@extension("x-texera-kind", #{ kind: "settings", plural: "settings", versioned: false, content: "spec", singleton: true })
model Settings is Typed<SettingsSpec, SettingsStatus>;
model UpdateSettings is UpdateSpec<SettingsSpec>;

namespace Routes {
  @route("/settings")
  interface SettingsRoutes {
    @get
    @extension("x-texera-permission", "self")
    read(): Settings | Error;

    @put
    @extension("x-texera-permission", "admin")
    update(@header("If-Match") ifMatch?: string, @body body: UpdateSettings): Settings | Error;

    @doc("Served without a token.")
    @get
    @route("/public")
    @extension("x-texera-permission", "public")
    `public`(): PublicSettings | Error;

    @doc("Run one retention sweep now, as the hourly one does: expire the results past the policy and remove unreferenced blobs.")
    @post
    @route("/retention/sweep")
    @extension("x-texera-permission", "admin")
    sweep(): RetentionSweep | Error;
  }
}
