// The envelope and the shapes every kind shares.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../common.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

@doc("A resource URI: `texera://` followed by the resource's REST path, optionally `@vno` and a subresource path, e.g. `texera://datasets/{rid}@2/files/iris.csv`.")
scalar Uri extends string;

@doc("A SHA-256 digest, `sha256:` followed by 64 hex characters.")
scalar Digest extends string;

@doc("The kinds. The value is the singular kebab-case kind; the collection is its plural.")
enum ResourceKind {
  project,
  workflow,
  execution,
  dataset,
  `model`,
  environment,
  computingUnit: "computing-unit",
  operator,
  agentTemplate: "agent-template",
  skill,
  mcpServer: "mcp-server",
  conversation,
  credential,
  modelEndpoint: "model-endpoint",
  settings,
}

enum Visibility {
  private,
  public,
}

@doc("The grantable relations. `user` is for computing units: may run on it, without reading its spec.")
enum Relation {
  owner,
  editor,
  viewer,
  user,
}

@doc("How much of a heavy spec a list carries: `summary` leaves out the large fields, `full` keeps them.")
enum View {
  summary,
  full,
}

@doc("Where a resource or version came from: the chat turn that produced it, and the agent template that ran the turn.")
model Origin {
  conversation: Rid;
  @doc("The turn id, a UUID.")
  turn: string;
  @doc("The agent template version that ran the turn, as a URI with `@vno`.")
  template?: Uri;
}

model ResourceMetadata {
  rid: Rid;
  uri: Uri;
  name: string;
  description?: string;
  @doc("The immediate parent: the project of a top-level resource, the workflow of an execution. Absent for a project.")
  parent?: Rid;
  @doc("The nearest project: the resource itself for a project.")
  project: Rid;
  owner: Pid;
  visibility: Visibility;
  labels?: Record<string>;
  @doc("The newest version number; 0 for an unversioned kind.")
  head: Vno;
  @doc("Changes on every write; send it back as If-Match to refuse lost updates.")
  etag: string;
  createdBy: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

@doc("The untyped envelope, served by the generic routes.")
model Resource {
  apiVersion: "catalog.texera.apache.org/v1";
  kind: ResourceKind;
  metadata: ResourceMetadata;
  spec: Record<unknown>;
  status?: Record<unknown>;
}

@doc("The typed envelope, served by the kind routes.")
model Typed<Spec, Status> {
  apiVersion: "catalog.texera.apache.org/v1";
  kind: ResourceKind;
  metadata: ResourceMetadata;
  spec: Spec;
  status?: Status;
}

model Create<Spec> {
  name: string;
  description?: string;
  @doc("The parent; for a top-level kind a project, default the caller's home project.")
  parent?: Rid;
  visibility?: Visibility;
  labels?: Record<string>;
  spec: Spec;
  @doc("Recorded on the first version of a versioned kind.")
  message?: string;
}

model UpdateSpec<Spec> {
  spec: Spec;
  @doc("Recorded on the new version of a versioned kind.")
  message?: string;
  @doc("The head version the caller saw; refused with 409 when it moved.")
  expectedHead?: Vno;
}

model UpdateMetadata {
  name?: string;
  description?: string;
  @doc("Moves a top-level resource to another project.")
  parent?: Rid;
  visibility?: Visibility;
  labels?: Record<string>;
}

@doc("What a version holds: a snapshot of the spec, a file manifest over blobs, or an Iceberg table reference.")
enum ContentKind {
  spec,
  manifest,
  table,
}

@doc("An immutable version of a resource.")
model Version {
  rid: Rid;
  @doc("The resource URI with `@vno`.")
  uri: Uri;
  kind: ResourceKind;
  vno: Vno;
  contentKind: ContentKind;
  @doc("SHA-256 of the canonical JSON of the content.")
  digest: Digest;
  content: unknown;
  message?: string;
  createdBy: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
}

@doc("A version without its content, as lists return it.")
model VersionSummary {
  rid: Rid;
  uri: Uri;
  vno: Vno;
  contentKind: ContentKind;
  digest: Digest;
  message?: string;
  createdBy: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
}

@doc("A version with typed content, served by the kind routes.")
model TypedVersion<Content> {
  rid: Rid;
  uri: Uri;
  kind: ResourceKind;
  vno: Vno;
  contentKind: ContentKind;
  digest: Digest;
  content: Content;
  message?: string;
  createdBy: Pid;
  origin?: Origin;
  createdAt: utcDateTime;
}

model Page<T> {
  items: T[];
  @doc("Opaque cursor for the next page; absent on the last page.")
  nextCursor?: string;
}

model Created<T> {
  @statusCode statusCode: 201;
  @body body: T;
}

model Accepted<T> {
  @statusCode statusCode: 202;
  @body body: T;
}

model Grant {
  rid: Rid;
  principal: Pid;
  relation: Relation;
  createdAt: utcDateTime;
}

model GrantRequest {
  relation: Relation;
}

enum PrincipalKind {
  user,
  group,
}

model Principal {
  pid: Pid;
  kind: PrincipalKind;
  displayName: string;
  @doc("The OIDC subject of a user.")
  subject?: string;
  email?: string;
  createdAt: utcDateTime;
}

@doc("The scope of a list.")
model Scoped {
  @doc("A project: the list holds what is in it and what it inherits, the platform's built-ins. Absent: the chat's project for a call made in a chat, else everything the caller may read. Projects themselves are never narrowed.")
  @query
  scope?: Rid;
}

@doc("The standard methods of a kind.")
interface KindRoutes<T, TPage, TCreate, TUpdate> {
  @doc("List the resources of this kind the caller may read.")
  @get
  @extension("x-texera-permission", "list")
  list(
    ...Scoped,
    @query parent?: Rid,
    @query project?: Rid,
    @query q?: string,
    @query limit?: int32,
    @query cursor?: string,
  ): Ok<TPage> | Error;

  @post
  @extension("x-texera-permission", "create")
  create(@body body: TCreate): Created<T> | Error;

  @get
  @route("/{rid}")
  @extension("x-texera-permission", "read")
  read(@path rid: Rid): T | Error;

  @doc("Replace the spec; for a versioned kind this creates a version.")
  @put
  @route("/{rid}")
  @extension("x-texera-permission", "write")
  update(@path rid: Rid, @header("If-Match") ifMatch?: string, @body body: TUpdate): T | Error;

  @doc("Delete the resource; refused with 409 while another resource references it.")
  @delete
  @route("/{rid}")
  @extension("x-texera-permission", "delete")
  delete(@path rid: Rid): void | Error;
}

@doc("The standard methods of a versioned kind: the kind's methods plus its versions.")
interface VersionedKindRoutes<T, TPage, TCreate, TUpdate, TVersion, TVersionPage>
  extends KindRoutes<T, TPage, TCreate, TUpdate> {
  @get
  @route("/{rid}/versions")
  @extension("x-texera-permission", "read")
  listVersions(@path rid: Rid, @query limit?: int32, @query cursor?: string): Ok<TVersionPage> | Error;

  @get
  @route("/{rid}/versions/{vno}")
  @extension("x-texera-permission", "read")
  readVersion(@path rid: Rid, @path vno: Vno): TVersion | Error;
}
