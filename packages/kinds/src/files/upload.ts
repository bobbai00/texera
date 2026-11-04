// Turning local files into a dataset version: create (or reuse) the dataset, upload every
// file into its staging area, commit a version.

import type { Version } from "@texera/catalog-client/types";
import { CatalogError, createResource } from "../api";
import type { ResourceRef } from "../types";
import { fileApi } from "./api";

export interface UploadOptions {
  /** The dataset to add a version to; a new dataset is created when absent. */
  rid?: string;
  name?: string;
  description?: string;
  parent?: string;
  message?: string;
  onStatus?: (status: string) => void;
}

const defaultName = (files: File[]) => {
  const first = files[0]?.name.replace(/\.[^.]+$/, "") ?? "dataset";
  return files.length > 1 ? `${first} and ${files.length - 1} more` : first;
};

export async function createDatasetVersion(files: File[], options: UploadOptions = {}): Promise<{ ref: ResourceRef; version: Version }> {
  if (files.length === 0) throw new Error("No files to upload.");
  const status = options.onStatus ?? (() => {});
  const api = fileApi("dataset");
  let rid = options.rid;
  if (!rid) {
    status("Creating the dataset");
    const name = options.name ?? defaultName(files);
    const create = (n: string) => createResource("dataset", { name: n, description: options.description, parent: options.parent, spec: {} });
    // Names are unique per project and kind; a second upload of the same file name gets its own dataset.
    const dataset = await create(name).catch(e => {
      if (e instanceof CatalogError && e.status === 409) return create(`${name} (${new Date().toLocaleTimeString("en", { hour12: false })})`);
      throw e;
    });
    rid = dataset.metadata.rid;
  }
  for (const [i, file] of files.entries()) {
    status(`Uploading ${file.name} (${i + 1} of ${files.length})`);
    await api.upload(rid, file.name, file);
  }
  status("Committing the version");
  const version = await api.commit(rid, options.message ?? `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`);
  return { ref: { kind: "dataset", rid, vno: version.vno }, version };
}
