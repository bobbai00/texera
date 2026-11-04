// model-endpoint: a language model an agent can run on: a provider, a model name and the
// credential that pays for it. The platform seeds one; people may add their own.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

enum ModelProvider {
  anthropic,
  openaiCompatible: "openai_compatible",
}

model ModelEndpointSpec {
  provider: ModelProvider;
  @doc("The model name the provider knows, e.g. claude-haiku-5-5.")
  `model`: string;
  @doc("For openai_compatible: the base URL.")
  baseUrl?: string;
  @doc("The credential whose secret is the provider key; absent for a provider that needs none.")
  credential?: Uri;
  @doc("What the model can do, free-form, e.g. tools, vision.")
  capabilities?: string[];
  maxOutputTokens?: int32;
}

model ModelEndpointStatus {}

@extension("x-texera-kind", #{ kind: "model-endpoint", plural: "model-endpoints", versioned: false, content: "spec", parent: "project" })
model ModelEndpoint is Typed<ModelEndpointSpec, ModelEndpointStatus>;
model ModelEndpointPage is Page<ModelEndpoint>;
model CreateModelEndpoint is Create<ModelEndpointSpec>;
model UpdateModelEndpoint is UpdateSpec<ModelEndpointSpec>;

namespace Routes {
  @route("/model-endpoints")
  interface ModelEndpoints extends KindRoutes<ModelEndpoint, ModelEndpointPage, CreateModelEndpoint, UpdateModelEndpoint> {}
}
