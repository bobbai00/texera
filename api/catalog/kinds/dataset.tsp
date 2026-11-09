// dataset: versioned files. A version is a manifest over content-addressed blobs; files are
// uploaded to a staging area and committed into a version.
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "../../common.tsp";
import "../core.tsp";

using Http;
using Rest;
using OpenAPI;

namespace Texera.Catalog;

model DatasetSpec {
  @doc("A content hint for the files, free-form, e.g. csv or parquet.")
  format?: string;
}

model DatasetStatus {
  @doc("Files and bytes of the head version.")
  files?: int32;
  bytes?: int64;
  @doc("Files staged for the next version, not yet committed.")
  staged?: int32;
}

model DatasetFile {
  path: string;
  size: int64;
  sha256: Digest;
  contentType?: string;
}

@doc("The content of a dataset or model version: files over content-addressed blobs.")
model Manifest {
  files: DatasetFile[];

  @doc("A model version's contract: what it reads and puts out.")
  contract?: ModelContract;
}

model CommitFiles {
  message?: string;

  @doc("For a model, the new version's contract; absent, a contract.json among the staged files says it, else the head version's carries over. A model version may change only its contract.")
  contract?: ModelContract;
}

@doc("A file attached to a chat, kept as a dataset of the chat's project.")
model KeepAttachment {
  @doc("What to call the dataset; absent, it keeps the file's name.")
  name?: string;

  @doc("What it holds and where it comes from.")
  description?: string;
}

@doc("A whole file.")
model FileBytes {
  @statusCode statusCode: 200;
  @header contentType: "application/octet-stream";
  @body data: bytes;
}

@doc("A range of a file.")
model FilePartial {
  @statusCode statusCode: 206;
  @header contentType: "application/octet-stream";
  @header("Content-Range") contentRange: string;
  @body data: bytes;
}

model FileLink {
  @doc("A presigned URL valid for `expiresInSeconds`.")
  url: string;
  expiresInSeconds: int32;
}

@doc("A file the catalog fetches itself into the staging area, from the internet.")
model ImportFile {
  @doc("An https URL on the public internet. An address on a private network, the platform's own services among them, is refused, and so are a URL with a user and password in it and a redirect to plain http.")
  url: string;
  @doc("The path it is staged at; absent, the last segment of the URL's path.")
  path?: string;
}

@extension("x-texera-kind", #{ kind: "dataset", plural: "datasets", versioned: true, content: "manifest", parent: "project" })
model Dataset is Typed<DatasetSpec, DatasetStatus>;
model DatasetPage is Page<Dataset>;
model CreateDataset is Create<DatasetSpec>;
model UpdateDataset is UpdateSpec<DatasetSpec>;
model DatasetVersion is TypedVersion<Manifest>;
model DatasetVersionPage is Page<VersionSummary>;

@doc("The file subresources of a manifest-versioned kind: staging, commit, and the files of a version.")
interface FileRoutes<TVersion> {
  @doc("Upload a file into the staging area; commit makes a version. The same bytes are stored once.")
  @put
  @route("/{rid}/files/{path}")
  @extension("x-texera-permission", "write")
  upload(
    @path rid: Rid,
    @path path: string,
    @header contentType: "application/octet-stream",
    @body data: bytes,
  ): DatasetFile | Error;

  @doc("Fetch a file from the internet into the staging area, as upload stages bytes sent; commit makes a version. Up to the deployment's size limit (`TEXERA_IMPORT_MAX_BYTES`).")
  @post
  @route("/{rid}/import")
  @extension("x-texera-permission", "write")
  importFile(@path rid: Rid, @body body: ImportFile): DatasetFile | Error;

  @delete
  @route("/{rid}/files/{path}")
  @extension("x-texera-permission", "write")
  unstage(@path rid: Rid, @path path: string): void | Error;

  @get
  @route("/{rid}/staged")
  @extension("x-texera-permission", "read")
  staged(@path rid: Rid): Manifest | Error;

  @doc("Commit the staged files, over the head version's files, as a new version.")
  @post
  @route("/{rid}/commit")
  @extension("x-texera-permission", "write")
  commit(@path rid: Rid, @body body: CommitFiles): Created<TVersion> | Error;

  @get
  @route("/{rid}/versions/{vno}/files")
  @extension("x-texera-permission", "read")
  files(@path rid: Rid, @path vno: Vno): Manifest | Error;

  @doc("Read a file of a version; `Range` and `maxBytes` bound the answer.")
  @get
  @route("/{rid}/versions/{vno}/files/{path}")
  @extension("x-texera-permission", "read")
  download(
    @path rid: Rid,
    @path vno: Vno,
    @path path: string,
    @query maxBytes?: int32,
    @header("Range") range?: string,
  ): FileBytes | FilePartial | Error;

  @doc("A presigned URL for a file of a version, for engines and browsers.")
  @get
  @route("/{rid}/versions/{vno}/links/{path}")
  @extension("x-texera-permission", "read")
  link(@path rid: Rid, @path vno: Vno, @path path: string): FileLink | Error;
}

namespace Routes {
  @route("/datasets")
  interface Datasets
    extends VersionedKindRoutes<Dataset, DatasetPage, CreateDataset, UpdateDataset, DatasetVersion, DatasetVersionPage>,
      FileRoutes<DatasetVersion> {
    @post
    @extension("x-texera-permission", "create")
    @extension("x-mcp", #{
      tool: "create_dataset",
      description: "Create a dataset: a name, a description that says what it holds and where it comes from, and a format hint such as csv. It goes into the chat's project unless parent names another. It has no files until import_dataset_file stages one and commit_dataset_version makes its first version.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    create(@body body: CreateDataset): Created<Dataset> | Error;

    @doc("Fetch a file from the internet into the staging area; commit makes a version.")
    @post
    @route("/{rid}/import")
    @extension("x-texera-permission", "write")
    @extension("x-mcp", #{
      tool: "import_dataset_file",
      description: "Bring a file from the internet into a dataset: the catalog downloads an https URL itself, so its bytes never pass through the chat, and stages it at path (by default the URL's last segment). Only public addresses, up to the deployment's size limit. commit_dataset_version then makes the version: say in its message where the file came from.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    importFile(@path rid: Rid, @body body: ImportFile): DatasetFile | Error;

    @doc("Keep a file attached to a chat as a dataset of its project: from then on it is listed like any other, and outlives the chat.")
    @post
    @route("/{rid}/keep")
    @extension("x-texera-permission", "write")
    @extension("x-mcp", #{
      tool: "keep_attachment",
      description: "Keep a file attached to this chat as a dataset of the project, when the person asks for that: give it a name and a description of what it holds and where it comes from. Until then an attached file is the chat's own: a workflow can read it, and it is in no list of the project.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    keep(@path rid: Rid, @body body: KeepAttachment): Dataset | Error;

    @doc("Commit the staged files as a new version.")
    @post
    @route("/{rid}/commit")
    @extension("x-texera-permission", "write")
    @extension("x-mcp", #{
      tool: "commit_dataset_version",
      description: "Commit a dataset's staged files as a new immutable version.",
      readOnlyHint: false,
      destructiveHint: false,
    })
    commit(@path rid: Rid, @body body: CommitFiles): Created<DatasetVersion> | Error;

    @get
    @route("/{rid}/versions/{vno}/files")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "list_dataset_files",
      description: "List the files of a dataset or model version with sizes and digests; a model version's manifest also holds its contract.",
      readOnlyHint: true,
    })
    files(@path rid: Rid, @path vno: Vno): Manifest | Error;

    @doc("Read a file of a version; `Range` and `maxBytes` bound the answer.")
    @get
    @route("/{rid}/versions/{vno}/files/{path}")
    @extension("x-texera-permission", "read")
    @extension("x-mcp", #{
      tool: "read_dataset_file",
      description: "Read the beginning of a dataset or model version's file (bounded bytes), e.g. a CSV header or a model's README.",
      readOnlyHint: true,
    })
    download(
      @path rid: Rid,
      @path vno: Vno,
      @path path: string,
      @query maxBytes?: int32,
      @header("Range") range?: string,
    ): FileBytes | FilePartial | Error;
  }
}
