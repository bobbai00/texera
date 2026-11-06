// warehouse: where executions keep their result tables. A warehouse is a place in an object
// store that the lake (the Iceberg REST catalog) manages: the location, the key to it, and the
// tables under it. An execution runs on a computing unit and keeps its results in a warehouse.
// Unversioned. One is built in, on the deployment's own store; a project can have its own, on
// the deployment's store or on a store of the project's.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("A place in an S3-compatible object store that is the warehouse's alone. The store must hand out short-lived keys itself (STS, as MinIO and RustFS do): that is how a unit reaches one table's files.")
model WarehouseStorage {
  @doc("The store's endpoint, as the lake and the computing units reach it. It is the deployment's own store or one an administrator listed in the settings (`warehouseEndpoints`).")
  endpoint: string;
  region: string;
  bucket: string;
  @doc("A path in the bucket that only this warehouse uses; absent: the whole bucket.")
  keyPrefix?: string;
  @doc("The credential the lake uses for the bucket; its secret holds `accessKeyId` and `secretAccessKey`. No computing unit ever gets it: the lake hands a unit short-lived access to the tables it may touch.")
  credential: Uri;
}

model WarehouseSpec {
  @doc("A store of the owner's to keep the tables in. Absent: a place of its own on the deployment's store.")
  storage?: WarehouseStorage;
}

model WarehouseStatus {
  @doc("The warehouse's name in the lake: what an Iceberg client passes as `warehouse`.")
  name?: string;
}

@extension("x-texera-kind", #{ kind: "warehouse", plural: "warehouses", versioned: false, content: "spec", parent: "project" })
model Warehouse is Typed<WarehouseSpec, WarehouseStatus>;
model WarehousePage is Page<Warehouse>;
model CreateWarehouse is Create<WarehouseSpec>;
model UpdateWarehouse is UpdateSpec<WarehouseSpec>;

namespace Routes {
  @route("/warehouses")
  interface Warehouses extends KindRoutes<Warehouse, WarehousePage, CreateWarehouse, UpdateWarehouse> {}
}
