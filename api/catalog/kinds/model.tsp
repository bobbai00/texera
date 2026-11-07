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

@doc("What a model version reads and puts out, so a workflow pinned to the version is checked against it: predict checks its input's columns against the inputs and adds the outputs.")
model ModelContract {
  @doc("How the version is loaded and called: `sklearn`, a fitted estimator saved with joblib or pickle; or `python`, an entry file that defines load(directory) and predict(model, frame).")
  framework: "sklearn" | "python";

  @doc("The file in the version that holds the model, or for python the entry file: model.joblib, predict.py.")
  entry: string;

  @doc("The columns it reads, in the order it reads them, each with its type.")
  inputs: Attribute[];

  @doc("The columns it adds. For sklearn, the first is what predict gives; a second, for a classifier, is the probability of its last class, the positive one of two. For python, those of the frame predict returns.")
  outputs: Attribute[];

  @doc("What it needs to run well, said to whoever runs it: a GPU, much memory.")
  needs?: string;

  @doc("Whether it reads a whole group of rows at once, such as one patient's readings, so predict needs by.")
  grouped?: boolean;
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
