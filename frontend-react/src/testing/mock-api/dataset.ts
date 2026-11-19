/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// The dataset endpoints of the File Service (DatasetResource.scala, ResourceUploadService.scala). They answer
// with the fields the app reads, in the server's shapes, and fail with the server's statuses and messages.
// The shapes are written from the server's code, never from the app's types, so that a test fails when the
// app reads a field under a name the server does not send.

import { http, HttpResponse } from "msw/http";
import { admin } from "../fixtures";
import { errorResponse, type MockPrivilege, type MockResource, privilegeOf } from "./access";
import { signedInUser } from "./auth";
import type { MockDb } from "./index";

/** A dataset with its versions and files. Its owner, its visibility, and who it is shared with are in db.resources. */
export interface MockDataset {
  did: number;
  name: string;
  description: string;
  /** In epoch milliseconds. */
  creationTime: number;
  /** In the order they were made. */
  versions: MockVersion[];
  /** The files uploaded since the last version, by path: what the next version commits (LakeFS's branch main). */
  staged: Record<string, Uint8Array<ArrayBuffer>>;
  /** The multipart uploads in progress, by file path. */
  uploads: Record<string, MockUpload>;
}

export interface MockVersion {
  dvid: number;
  name: string;
  creationTime: number;
  /** Every file of the dataset at this version, not only the new ones, by path, such as "notes/README.md". */
  files: Record<string, Uint8Array<ArrayBuffer>>;
}

interface MockUpload {
  fileSize: number;
  partSize: number;
  /** The parts received so far, by part number. */
  parts: Record<number, Uint8Array<ArrayBuffer>>;
}

/** A dataset as a test describes it. Only the name is needed; the owner is the admin, and file contents are text. */
export interface DatasetSeed {
  name: string;
  description?: string;
  ownerUid?: number;
  isPublic?: boolean;
  grants?: MockResource["grants"];
  creationTime?: number;
  /** Oldest first. Each is made a day after the one before it. */
  versions?: { name: string; files: Record<string, string> }[];
}

/** A file or folder of a version, as LakeFSFileNodeSerializer.java writes it. */
type FileNodeJson =
  | { type: "file"; name: string; parentDir: string; size: number }
  | { type: "directory"; name: string; parentDir: string; children: FileNodeJson[] };

/** Where the links of presign-download point: the storage server, which LakeFS signs them for. */
const storage = "http://storage.test/texera-dataset";
const noAccess = "User has no access to this dataset";
const day = 24 * 60 * 60 * 1000;
const mebibyte = 1024 * 1024;

/** Adds a dataset, as if its owner had made it and its versions, and returns it. */
export function addDataset(db: MockDb, seed: DatasetSeed): MockDataset {
  const { name, description = "", ownerUid = admin.uid, isPublic = false, grants = [], versions = [] } = seed;
  const creationTime = seed.creationTime ?? Date.UTC(2026, 10, 12, 12);
  const firstDvid = nextDvid(db);
  const dataset: MockDataset = {
    did: Math.max(0, ...db.datasets.map(other => other.did)) + 1,
    name,
    description,
    creationTime,
    versions: versions.map((version, index) => ({
      dvid: firstDvid + index,
      name: version.name,
      creationTime: creationTime + (index + 1) * day,
      files: Object.fromEntries(Object.entries(version.files).map(([path, text]) => [path, bytesOf(text)])),
    })),
    staged: {},
    uploads: {},
  };
  db.datasets.push(dataset);
  db.resources.push({ type: "dataset", id: dataset.did, ownerUid, isPublic, grants });
  return dataset;
}

/** A dataset as the server sends it (DashboardDataset) to a user with this privilege on it. */
export function dashboardDataset(
  db: MockDb,
  dataset: MockDataset,
  uid: number,
  accessPrivilege: MockPrivilege | "NONE"
) {
  const { did, name, description, creationTime } = dataset;
  const { ownerUid, isPublic } = db.resources.find(resource => resource.type === "dataset" && resource.id === did)!;
  return {
    dataset: { did, name, description, isPublic, creationTime },
    ownerEmail: db.users.find(user => user.uid === ownerUid)!.email,
    accessPrivilege,
    isOwner: ownerUid === uid,
  };
}

export function datasetHandlers(db: MockDb) {
  function resourceOf(dataset: MockDataset): MockResource {
    return db.resources.find(resource => resource.type === "dataset" && resource.id === dataset.did)!;
  }

  function emailOf(uid: number): string {
    return db.users.find(user => user.uid === uid)!.email;
  }

  /**
   * The dataset and the signed-in user's privilege on it, when the user may view it, change it ("WRITE"), or
   * delete it ("OWNER"); otherwise the server's answer.
   */
  function authorize(request: Request, did: number, needs: "READ" | "WRITE" | "OWNER") {
    const user = signedInUser(db, request);
    if (user instanceof Response) return user;
    const dataset = db.datasets.find(candidate => candidate.did === did);
    if (!dataset) return errorResponse(404, `Dataset ${did} not found`);
    const resource = resourceOf(dataset);
    const privilege = privilegeOf(resource, user.uid);
    const allowed = {
      READ: resource.isPublic || privilege !== "NONE",
      WRITE: privilege === "WRITE",
      OWNER: resource.ownerUid === user.uid,
    }[needs];
    return allowed ? { user, dataset, privilege } : errorResponse(403, noAccess);
  }

  /** The dataset named by its owner's email and its name, as the multipart calls name it, if the user may change it. */
  function uploadTarget(request: Request, url: URL) {
    const user = signedInUser(db, request);
    if (user instanceof Response) return user;
    const owner = db.users.find(candidate => candidate.email === url.searchParams.get("ownerEmail"));
    const dataset = db.datasets.find(
      candidate =>
        candidate.name === url.searchParams.get("datasetName") && resourceOf(candidate).ownerUid === owner?.uid
    );
    if (!dataset) return errorResponse(400, "Dataset not found");
    return privilegeOf(resourceOf(dataset), user.uid) === "WRITE" ? dataset : errorResponse(403, noAccess);
  }

  return [
    // GET /dataset/list -> every dataset the user may read: their own, those shared with them, and the public ones.
    http.get("/api/dataset/list", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const readable = db.datasets.filter(dataset => {
        const resource = resourceOf(dataset);
        return resource.isPublic || privilegeOf(resource, user.uid) !== "NONE";
      });
      return HttpResponse.json(
        readable.map(dataset => {
          const privilege = privilegeOf(resourceOf(dataset), user.uid);
          // The server says a public dataset that is not shared with the user may be read.
          return dashboardDataset(db, dataset, user.uid, privilege === "NONE" ? "READ" : privilege);
        })
      );
    }),
    // GET /dataset/presign-download?filePath=/dataset/<owner email>/<dataset>/<version>/<path> -> {presignedUrl}
    http.get("/api/dataset/presign-download", ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const [, , ownerEmail, datasetName, versionName, ...path] = filePathOf(new URL(request.url)).split("/");
      const owner = db.users.find(candidate => candidate.email === ownerEmail);
      const dataset = db.datasets.find(
        candidate => candidate.name === datasetName && resourceOf(candidate).ownerUid === owner?.uid
      );
      const version = dataset?.versions.find(candidate => candidate.name === versionName);
      const filePath = path.join("/");
      if (!dataset || !version?.files[filePath]) {
        return HttpResponse.json(
          { message: `Error while generating a presigned URL for file '${filePath}': LakeFS resource not found.` },
          { status: 404 }
        );
      }
      const resource = resourceOf(dataset);
      if (!resource.isPublic && privilegeOf(resource, user.uid) === "NONE") return errorResponse(403, noAccess);
      return HttpResponse.json({ presignedUrl: `${storage}/${version.dvid}?path=${encodeURIComponent(filePath)}` });
    }),

    // A presigned link: the file itself, from the storage server. The link grants access, so it needs no token. The
    // server calls every file "binary/octet-stream", and sends part of one for a range, as S3 does.
    http.get<{ dvid: string }>(`${storage}/:dvid`, ({ request, params }) => {
      const version = db.datasets.flatMap(dataset => dataset.versions).find(({ dvid }) => dvid === Number(params.dvid));
      const file = version?.files[new URL(request.url).searchParams.get("path") ?? ""];
      if (!file) return HttpResponse.xml("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      const headers = { "Content-Type": "binary/octet-stream" };
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("Range") ?? "");
      if (!range) return new HttpResponse(file, { headers });
      const [start, end] = [Number(range[1]), Math.min(Number(range[2]), file.length - 1)];
      return new HttpResponse(file.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.length}` },
      });
    }),

    // POST /dataset/create {datasetName, datasetDescription, isDatasetPublic, isDatasetDownloadable}
    http.post("/api/dataset/create", async ({ request }) => {
      const user = signedInUser(db, request);
      if (user instanceof Response) return user;
      const unsupported = unsupportedMediaType(request, "application/json");
      if (unsupported) return unsupported;
      const { datasetName, datasetDescription, isDatasetPublic } = (await request.json()) as {
        datasetName: string;
        datasetDescription: string;
        isDatasetPublic: boolean;
      };
      // ResourceNaming.validateName and requireNameAvailable: names are unique among one owner's datasets.
      if (!/^[A-Za-z0-9_-]+$/.test(datasetName)) {
        return errorResponse(400, "Invalid dataset name: only letters, numbers, underscores, and hyphens are allowed.");
      }
      if (datasetName.length > 128) {
        return errorResponse(400, "Invalid dataset name: name must be at most 128 characters long.");
      }
      if (db.datasets.some(dataset => dataset.name === datasetName && resourceOf(dataset).ownerUid === user.uid)) {
        return errorResponse(400, "Dataset with the same name already exists");
      }
      const dataset = addDataset(db, {
        name: datasetName,
        description: datasetDescription,
        ownerUid: user.uid,
        isPublic: isDatasetPublic,
        creationTime: Date.now(),
      });
      return HttpResponse.json(dashboardDataset(db, dataset, user.uid, "WRITE"));
    }),

    // POST /dataset/multipart-upload?type=init|finish|abort&ownerEmail&datasetName&filePath, with an empty JSON body.
    // init also takes fileSizeBytes, partSizeBytes and restart, and answers which parts to send.
    http.post("/api/dataset/multipart-upload", ({ request }) => {
      const unsupported = unsupportedMediaType(request, "application/json");
      if (unsupported) return unsupported;
      const url = new URL(request.url);
      const type = url.searchParams.get("type");
      // The server also lists unfinished uploads (type=list), which this app does not use.
      if (type !== "init" && type !== "finish" && type !== "abort") {
        return errorResponse(400, "Invalid type parameter. Use 'list', 'init', 'finish', 'abort'.");
      }
      const dataset = uploadTarget(request, url);
      if (dataset instanceof Response) return dataset;
      const filePath = filePathOf(url);
      const upload = dataset.uploads[filePath];

      if (type === "init") {
        const fileSize = Number(url.searchParams.get("fileSizeBytes"));
        const partSize = Number(url.searchParams.get("partSizeBytes"));
        const maxFileSize = Number(db.settings.dataset_single_file_upload_max_size_mib) * mebibyte;
        if (!(fileSize > 0)) return errorResponse(400, "fileSizeBytes must be > 0");
        if (fileSize > maxFileSize) {
          return errorResponse(400, `fileSizeBytes=${fileSize} exceeds singleFileUploadMaxBytes=${maxFileSize}`);
        }
        if (!(partSize > 0)) return errorResponse(400, "partSizeBytes must be > 0");
        // An unfinished upload of the same size in the same parts is resumed, unless restart is true
        // (ResourceUploadService.scala); anything else starts over.
        const resumed =
          url.searchParams.get("restart") !== "true" && upload?.fileSize === fileSize && upload.partSize === partSize;
        const started = resumed ? upload : (dataset.uploads[filePath] = { fileSize, partSize, parts: {} });
        return HttpResponse.json({ missingParts: missingParts(started) });
      }

      if (!upload) return errorResponse(404, "Upload session not found or already finalized");
      if (type === "abort") {
        delete dataset.uploads[filePath];
        return HttpResponse.json({ message: "Multipart upload aborted successfully" });
      }
      const missing = missingParts(upload);
      if (missing.length > 0) {
        return errorResponse(409, `Upload incomplete. Some missing ETags for parts are: ${missing.join(", ")}`);
      }
      delete dataset.uploads[filePath];
      dataset.staged[filePath] = concat(partNumbers(upload).map(partNumber => upload.parts[partNumber]));
      return HttpResponse.json({ message: "Multipart upload completed successfully", filePath });
    }),

    // POST /dataset/multipart-upload/part?ownerEmail&datasetName&filePath&partNumber, with the part's bytes.
    // Every part but the last is partSizeBytes long. (The server also wants at least 5 MiB, which this skips.)
    http.post("/api/dataset/multipart-upload/part", async ({ request }) => {
      const unsupported = unsupportedMediaType(request, "application/octet-stream");
      if (unsupported) return unsupported;
      const url = new URL(request.url);
      const dataset = uploadTarget(request, url);
      if (dataset instanceof Response) return dataset;
      const upload = dataset.uploads[filePathOf(url)];
      if (!upload) return errorResponse(404, "Upload session not found. Call type=init first.");
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (!partNumbers(upload).includes(partNumber)) {
        return errorResponse(400, `${partNumber} exceeds the requested parts on init: ${partNumbers(upload).length}`);
      }
      const expected = Math.min(upload.partSize, upload.fileSize - (partNumber - 1) * upload.partSize);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== expected) {
        return errorResponse(
          400,
          `Invalid part size for partNumber=${partNumber}. Expected Content-Length=${expected}, got ${bytes.byteLength}.`
        );
      }
      upload.parts[partNumber] = bytes;
      return new HttpResponse();
    }),

    // GET /dataset/{did}: the dataset, and what the user may do with it ("NONE" for a public one not shared with them).
    http.get<{ did: string }>("/api/dataset/:did", ({ request, params }) => {
      const found = authorize(request, Number(params.did), "READ");
      if (found instanceof Response) return found;
      return HttpResponse.json(dashboardDataset(db, found.dataset, found.user.uid, found.privilege));
    }),

    // DELETE /dataset/{did}: only its owner may delete a dataset.
    http.delete<{ did: string }>("/api/dataset/:did", ({ request, params }) => {
      const found = authorize(request, Number(params.did), "OWNER");
      if (found instanceof Response) return found;
      const resource = resourceOf(found.dataset);
      db.datasets = db.datasets.filter(dataset => dataset !== found.dataset);
      db.resources = db.resources.filter(other => other !== resource);
      return new HttpResponse();
    }),

    // GET /dataset/{did}/version/list: newest first.
    http.get<{ did: string }>("/api/dataset/:did/version/list", ({ request, params }) => {
      const found = authorize(request, Number(params.did), "READ");
      if (found instanceof Response) return found;
      const { dataset } = found;
      return HttpResponse.json(dataset.versions.toReversed().map(datasetVersion));
    }),

    // GET /dataset/{did}/version/{dvid}/rootFileNodes -> {fileNodes}: the files and folders at the top of the version.
    http.get<{ did: string; dvid: string }>("/api/dataset/:did/version/:dvid/rootFileNodes", ({ request, params }) => {
      const found = authorize(request, Number(params.did), "READ");
      if (found instanceof Response) return found;
      const { dataset } = found;
      const version = dataset.versions.find(candidate => candidate.dvid === Number(params.dvid));
      if (!version) return errorResponse(404, "Dataset Version not found");
      const versionPath = `/dataset/${emailOf(resourceOf(dataset).ownerUid)}/${dataset.name}/${version.name}`;
      return HttpResponse.json({ fileNodes: fileNodes(versionPath, version.files) });
    }),

    // POST /dataset/{did}/version/create, with the description as text: commits every staged file.
    // The server also answers with the version's files; the app reads only the version.
    http.post<{ did: string }>("/api/dataset/:did/version/create", async ({ request, params }) => {
      const unsupported = unsupportedMediaType(request, "text/plain");
      if (unsupported) return unsupported;
      const found = authorize(request, Number(params.did), "WRITE");
      if (found instanceof Response) return found;
      const { dataset } = found;
      const description = await request.text();
      if (description.includes("/")) {
        return errorResponse(
          400,
          "Invalid version description: '/' is not allowed because the version name is part of the paths of its files."
        );
      }
      if (Object.keys(dataset.staged).length === 0) {
        return errorResponse(400, "No changes detected in dataset. Version creation aborted.");
      }
      const number = dataset.versions.length + 1;
      const version: MockVersion = {
        dvid: nextDvid(db),
        name: description ? `v${number} - ${description}` : `v${number}`,
        creationTime: Date.now(),
        files: { ...dataset.versions.at(-1)?.files, ...dataset.staged },
      };
      dataset.versions.push(version);
      dataset.staged = {};
      return HttpResponse.json({ datasetVersion: datasetVersion(version) });
    }),
  ];
}

function datasetVersion({ dvid, name, creationTime }: MockVersion) {
  return { dvid, name, creationTime };
}

/** Version ids are unique across datasets, like the server's serial dvid. */
function nextDvid(db: MockDb): number {
  return Math.max(0, ...db.datasets.flatMap(dataset => dataset.versions.map(version => version.dvid))) + 1;
}

/** The numbers of an upload's parts, from 1. */
function partNumbers({ fileSize, partSize }: MockUpload): number[] {
  return Array.from({ length: Math.ceil(fileSize / partSize) }, (_, index) => index + 1);
}

function missingParts(upload: MockUpload): number[] {
  return partNumbers(upload).filter(partNumber => !upload.parts[partNumber]);
}

/**
 * The filePath of a multipart or download call. The server decodes it twice: as a query parameter, then again
 * with Java's URLDecoder, which also reads "+" as a space and fails on a "%" that starts no escape.
 */
function filePathOf(url: URL): string {
  return decodeURIComponent((url.searchParams.get("filePath") ?? "").replaceAll("+", " "));
}

/** Each endpoint takes one content type (JAX-RS @Consumes), and answers any other with 415. */
function unsupportedMediaType(request: Request, type: string): Response | undefined {
  if (!request.headers.get("Content-Type")?.startsWith(type)) {
    return errorResponse(415, "HTTP 415 Unsupported Media Type");
  }
}

/** The files and folders at one level of a version, as LakeFSFileNode.scala lists them: in reverse order of name. */
function fileNodes(parentDir: string, files: Record<string, Uint8Array>): FileNodeJson[] {
  const nodes: FileNodeJson[] = [];
  const folders: Record<string, Record<string, Uint8Array>> = {};
  for (const [path, bytes] of Object.entries(files)) {
    const [name, ...rest] = path.split("/");
    if (rest.length === 0) nodes.push({ type: "file", name, parentDir, size: bytes.byteLength });
    else (folders[name] ??= {})[rest.join("/")] = bytes;
  }
  for (const [name, inside] of Object.entries(folders)) {
    nodes.push({ type: "directory", name, parentDir, children: fileNodes(`${parentDir}/${name}`, inside) });
  }
  return nodes.sort((a, b) => (a.name < b.name ? 1 : -1));
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
