// model: a trained artifact, versioned like a dataset (a manifest over blobs) with a pointer to
// the execution port that produced it.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";
import "./dataset.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model ModelSpec {
  @doc("The framework, e.g. sklearn, pytorch, onnx.")
  framework?: string;
  @doc("The serialization format, e.g. pickle, safetensors, onnx.")
  format?: string;
  @doc("The task, e.g. classification.")
  task?: string;
  @doc("The execution port URI the head version was produced by.")
  producedBy?: Uri;
}

model ModelStatus {
  files?: int32;
  bytes?: int64;
  staged?: int32;
}

@extension("x-texera-kind", #{ kind: "model", plural: "models", versioned: true, content: "manifest", parent: "project" })
model Model is Typed<ModelSpec, ModelStatus>;
model ModelPage is Page<Model>;
model CreateModel is Create<ModelSpec>;
model UpdateModel is UpdateSpec<ModelSpec>;
model ModelVersion is TypedVersion<Manifest>;
model ModelVersionPage is Page<VersionSummary>;

namespace Routes {
  @route("/models")
  interface Models
    extends VersionedKindRoutes<Model, ModelPage, CreateModel, UpdateModel, ModelVersion, ModelVersionPage>,
      FileRoutes<ModelVersion> {}
}
