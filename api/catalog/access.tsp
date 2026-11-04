// The access decision endpoint (AuthZEN 1.0 evaluation): the gateway and other services ask
// here; OpenFGA answers behind it.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model AuthzSubject {
  type: string;
  id: string;
  properties?: Record<unknown>;
}

model AuthzAction {
  name: string;
}

model AuthzResource {
  type: string;
  id: string;
  properties?: Record<unknown>;
}

model AuthzRequest {
  subject: AuthzSubject;
  action: AuthzAction;
  resource: AuthzResource;
  context?: Record<unknown>;
}

model AuthzResponse {
  decision: boolean;
  context?: Record<unknown>;
}

@route("/access/v1")
namespace AccessRoutes {
  @route("/evaluation")
  interface Evaluation {
    @doc("AuthZEN access evaluation.")
    @post
    @extension("x-texera-permission", "self")
    evaluate(@body body: AuthzRequest): AuthzResponse | Error;
  }
}
