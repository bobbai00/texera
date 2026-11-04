// Lineage: one table of arrows between URIs, an index rebuilt from specs and OpenLineage
// events. Runtime lineage enters through the OpenLineage endpoint; references are extracted
// from every version's content.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";
import "./core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("The relations. `references`: a version's spec names the target. `used`: an execution read the target at a port. `produced`: an execution's port produced the target result. `derivedFrom`: a version was saved from a port result. `reused`: a port reused an earlier port's result.")
enum EdgeRelation {
  references,
  used,
  produced,
  derivedFrom,
  reused,
}

model Edge {
  from: Uri;
  relation: EdgeRelation;
  to: Uri;
  @doc("For `references`: the JSON pointer into the spec that held the URI.")
  field?: string;
  @doc("For runtime relations: the execution that caused the arrow.")
  execution?: Rid;
  @doc("For `produced`: table, snapshot, rows, bytes, hash; for `used`: the port.")
  attrs?: Record<unknown>;
  at: utcDateTime;
}

enum LineageDirection {
  upstream,
  downstream,
  both,
}

model LineageGraph {
  @doc("The URI the walk started from.")
  root: Uri;
  edges: Edge[];
}

@route("/lineage/v1")
namespace LineageRoutes {
  @route("/events")
  interface Events {
    @doc("OpenLineage run events posted by engines and other producers; service authentication.")
    @post
    @extension("x-texera-permission", "service")
    ingest(@body body: LineageEvent): void | Error;
  }
}
