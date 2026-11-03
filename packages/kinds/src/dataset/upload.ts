// Turning local files into a dataset version: create (or reuse) the dataset, upload every
// file into its staging area, commit a version.

import { datasetsCommit, datasetsCreate, datasetsUpload } from "@texera/catalog-client";
import type { Origin, ResourceVersion } from "@texera/catalog-client/types";
import { unwrap } from "../api";
import type { ResourceRef } from "../types";

export interface UploadOptions {
  /** The dataset to add a version to; a new dataset is created when absent. */
  rid?: string;
  name?: string;
  description?: string;
  project?: string;
  origin?: Origin;
  message?: string;
  onStatus?: (status: string) => void;
}

const defaultName = (files: File[]) => {
  const first = files[0]?.name.replace(/\.[^.]+$/, "") ?? "dataset";
  return files.length > 1 ? `${first} and ${files.length - 1} more` : first;
};

export async function createDatasetVersion(
  files: File[],
  options: UploadOptions = {}
): Promise<{ ref: ResourceRef; version: ResourceVersion }> {
  if (files.length === 0) throw new Error("No files to upload.");
  const status = options.onStatus ?? (() => {});
  let rid = options.rid;
  if (!rid) {
    status("Creating the dataset");
    const dataset = await unwrap(
      datasetsCreate({
        body: { name: options.name ?? defaultName(files), description: options.description, project: options.project, spec: {}, origin: options.origin },
      })
    );
    rid = dataset.metadata.rid;
  }
  for (const [i, file] of files.entries()) {
    status(`Uploading ${file.name} (${i + 1} of ${files.length})`);
    await unwrap(datasetsUpload({ path: { rid, path: file.name }, body: file }));
  }
  status("Committing the version");
  const version = await unwrap(datasetsCommit({ path: { rid }, body: { message: options.message ?? `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`, origin: options.origin } }));
  return { ref: { kind: "dataset", rid, vno: version.vno }, version };
}
