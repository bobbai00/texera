// What belongs to the installation rather than to one project: what the app shows before anyone
// has signed in, and the retention sweep. Texera, the project at the top of every chain, holds
// the rest: its settings are what every project inherits unless it sets its own.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";
import "./core.tsp";
import "./kinds/project.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model AuthSettings {
  issuer: string;
  clientId: string;
}

@doc("What the app needs before anyone has signed in: Texera's look and how to sign in.")
model PublicInfo {
  branding: Branding;
  auth: AuthSettings;
}

@doc("What one retention sweep did.")
model RetentionSweep {
  executionsExpired: int32;
  blobsDeleted: int32;
}

namespace Routes {
  @route("/public")
  interface Public {
    @doc("Served without a token.")
    @get
    @extension("x-texera-permission", "public")
    read(): PublicInfo | Error;
  }

  @route("/retention")
  interface Retention {
    @doc("Run one retention sweep now, as the hourly one does: drop the result tables each project's limits let go, and remove the uploads nothing names. Texera's admins may.")
    @post
    @route("/sweep")
    @extension("x-texera-permission", "admin")
    sweep(): RetentionSweep | Error;
  }
}
