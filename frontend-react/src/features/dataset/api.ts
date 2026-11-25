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

// The calls the app makes to the File Service's /dataset endpoints (DatasetResource.scala), beyond what every
// kind of resource shares: finding datasets and sharing them go through components/resource/api.ts. A dataset is
// a Resource and its versions are ResourceVersions, so the backend's field names (did, dvid, creationTime) stop
// at these two files.

import { queryOptions } from "@tanstack/react-query";
import { type DatasetAnswer, fromDatasetAnswer, resourceKey, resourceListKey } from "@/components/resource/api";
import type { Settings } from "@/components/settings/api";
import { api } from "@/lib/api-client";
import { downloadFile } from "@/lib/download";
import type { Resource, ResourceDeletion, ResourceVersion } from "@/lib/resource";
import { readPreview } from "./preview";

/** A file or folder of a version. A file's path, parentDir + "/" + name, is what a download asks for. */
export type FileNode = DatasetFile | DatasetFolder;

export interface DatasetFile {
  type: "file";
  name: string;
  parentDir: string;
  /** In bytes. */
  size: number;
}

export interface DatasetFolder {
  type: "directory";
  name: string;
  parentDir: string;
  children: FileNode[];
}

/** A version as the server sends it. Its name is "v1", or "v2 - " and the description it was made with. */
interface VersionAnswer {
  dvid: number;
  name: string;
  creationTime: number;
}

function fromVersionAnswer({ dvid, name, creationTime }: VersionAnswer): ResourceVersion {
  return { id: dvid, name, createdAt: creationTime };
}

// The keys nest under the dataset's, so refreshing or forgetting a dataset covers its versions and their files.
function datasetKey(id: number) {
  return resourceKey({ kind: "dataset", id });
}

/**
 * Every dataset the user may read a file of, all at once: their own, those shared with them, and everyone's
 * public ones (DatasetResource.listDatasets), to pick one from. They are found by name here, not by the dashboard
 * search, which misses some names: one with a word such as "ac822082" is not found by it.
 */
export function readableDatasetsQuery() {
  return queryOptions({
    queryKey: [...resourceListKey("dataset"), "readable"],
    queryFn: async () => (await api<DatasetAnswer[]>("/dataset/list")).map(fromDatasetAnswer),
  });
}

/** One dataset, as the signed-in user sees it. */
export function datasetQuery(id: number) {
  return queryOptions({
    queryKey: datasetKey(id),
    queryFn: async () => fromDatasetAnswer(await api<DatasetAnswer>(`/dataset/${id}`)),
  });
}

/** The versions of a dataset, newest first. */
export function versionListQuery(datasetId: number) {
  return queryOptions({
    queryKey: [...datasetKey(datasetId), "versions"],
    queryFn: async () =>
      (await api<VersionAnswer[]>(`/dataset/${datasetId}/version/list`))
        .map(fromVersionAnswer)
        .sort((a, b) => b.createdAt - a.createdAt),
  });
}

/** The files and folders at the top of a version. */
export function fileTreeQuery(datasetId: number, versionId: number) {
  return queryOptions({
    queryKey: [...datasetKey(datasetId), "versions", versionId, "files"],
    queryFn: async () =>
      (await api<{ fileNodes: FileNode[] }>(`/dataset/${datasetId}/version/${versionId}/rootFileNodes`)).fileNodes,
  });
}

const mebibyte = 1024 * 1024;

/** The largest file a dataset takes, in bytes, by the settings. An admin sets it; a new install takes 20 MiB. */
export function maxFileSize(settings: Settings): number {
  return Number(settings.dataset_single_file_upload_max_size_mib) * mebibyte;
}

/** Creates a dataset, which anyone who may view it may also download. */
export async function createDataset(dataset: {
  name: string;
  description: string;
  isPublic: boolean;
}): Promise<Resource> {
  const created = await api<DatasetAnswer>("/dataset/create", {
    method: "POST",
    json: {
      datasetName: dataset.name,
      datasetDescription: dataset.description,
      isDatasetPublic: dataset.isPublic,
      isDatasetDownloadable: true,
    },
  });
  return fromDatasetAnswer(created);
}

/** Deletes a dataset with all its versions and files. Only its owner may. */
export const datasetDeletion: ResourceDeletion = {
  run: id => api(`/dataset/${id}`, { method: "DELETE", responseType: "void" }),
  consequence: "Its versions and files are deleted too.",
};

/** Files go up in parts of 50 MiB, as the Angular app sends them. */
const partSize = 50 * mebibyte;

/**
 * Uploads a file to the dataset, where it waits for the next version: start a multipart upload, send the parts
 * the server asks for, one after another, and finish. When a part or the finish fails, or the signal aborts the
 * upload, the upload is cancelled. The server finds the dataset by its owner and name, not by its id.
 */
export async function uploadFile(
  { name: datasetName, owner: ownerEmail }: Pick<Resource, "name" | "owner">,
  file: File,
  signal?: AbortSignal
): Promise<void> {
  // The server decodes filePath twice (as a query parameter, then with URLDecoder), so it is encoded twice:
  // once here, once by api(). Encoded only once, a name with "+" or "%" would be read as another name.
  const upload = { ownerEmail, datasetName, filePath: encodeURIComponent(file.name) };
  const endUpload = (type: "finish" | "abort") =>
    api("/dataset/multipart-upload", {
      method: "POST",
      query: { type, ...upload },
      json: {},
      responseType: "void",
      // The abort is sent even after the signal has fired: it is what frees the upload on the server.
      signal: type === "finish" ? signal : undefined,
    });

  // Always a new upload: the server would otherwise resume an unfinished one of the same name and size, and keep
  // the bytes it already has.
  const { missingParts } = await api<{ missingParts: number[] }>("/dataset/multipart-upload", {
    method: "POST",
    query: { type: "init", ...upload, fileSizeBytes: file.size, partSizeBytes: partSize, restart: true },
    json: {},
    signal,
  });
  try {
    for (const partNumber of missingParts) {
      await api("/dataset/multipart-upload/part", {
        method: "POST",
        query: { ...upload, partNumber },
        body: file.slice((partNumber - 1) * partSize, partNumber * partSize),
        responseType: "void",
        signal,
      });
    }
    await endUpload("finish");
  } catch (error) {
    // Free what the server holds for the upload. Its failure, if any, matters less than the one being reported.
    await endUpload("abort").catch(() => {});
    throw error;
  }
}

/** Makes a version of every file uploaded since the last one. The server names it "v<n> - <description>". */
export async function createVersion(datasetId: number, description: string): Promise<ResourceVersion> {
  const { datasetVersion } = await api<{ datasetVersion: VersionAnswer }>(`/dataset/${datasetId}/version/create`, {
    method: "POST",
    body: description,
  });
  return fromVersionAnswer(datasetVersion);
}

/** A file's path, as downloads and previews ask for it: "/dataset/<owner>/<dataset>/<version>/<file>". */
export function filePath({ parentDir, name }: DatasetFile): string {
  return `${parentDir}/${name}`;
}

/** A link to a file of a version on the storage server, which the File Service signs: it grants access for a while. */
async function fileLink(file: DatasetFile): Promise<string> {
  // Encoded twice, as for uploads: the server decodes this path twice too.
  const { presignedUrl } = await api<{ presignedUrl: string }>("/dataset/presign-download", {
    query: { filePath: encodeURIComponent(filePath(file)) },
  });
  return presignedUrl;
}

/** Downloads a file of a version: the server gives a link to it on the storage server, and the file is saved. */
export async function downloadDatasetFile(file: DatasetFile): Promise<void> {
  await downloadFile(await fileLink(file), file.name);
}

/** How long a link that LakeFS signs is used for: less than the 15 minutes it lasts. */
const linkUseMs = 10 * 60_000;

/**
 * What is shown of a file of a version (preview.ts). Images, videos and sound are shown from the file's link, so the
 * preview is asked for again, with a new link, before the link runs out.
 */
export function filePreviewQuery(datasetId: number, file: DatasetFile) {
  return queryOptions({
    queryKey: [...datasetKey(datasetId), "preview", filePath(file)],
    queryFn: async () => readPreview({ name: file.name, size: file.size, url: await fileLink(file) }),
    staleTime: linkUseMs,
    gcTime: linkUseMs,
    retry: false,
  });
}
