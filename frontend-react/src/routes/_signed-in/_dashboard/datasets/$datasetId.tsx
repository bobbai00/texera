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

import { createFileRoute } from "@tanstack/react-router";
import { versionListQuery } from "@/components/resource/api";
import { datasetQuery, fileTreeQuery } from "@/features/dataset/api";
import { DatasetPage } from "@/features/dataset/components/dataset-page";

interface DatasetSearch {
  /** The id of the version to show. Without it, the page shows the newest. */
  version?: number;
  /** The path in the version of the file whose content to show. Without it, the page shows the README, or the first. */
  file?: string;
}

export const Route = createFileRoute("/_signed-in/_dashboard/datasets/$datasetId")({
  params: {
    // A dataset id is a number; any other address is not found.
    parse: ({ datasetId }) => (/^\d+$/.test(datasetId) ? { datasetId: Number(datasetId) } : false),
    stringify: ({ datasetId }) => ({ datasetId: String(datasetId) }),
  },
  validateSearch: ({ version, file }: Record<string, unknown>): DatasetSearch => ({
    version: typeof version === "number" ? version : undefined,
    file: typeof file === "string" && file !== "" ? file : undefined,
  }),
  loaderDeps: ({ search: { version } }) => ({ version }),
  loader: async ({ context: { queryClient }, params: { datasetId }, deps: { version } }) => {
    const [, versions] = await Promise.all([
      queryClient.ensureQueryData(datasetQuery(datasetId)),
      queryClient.ensureQueryData(versionListQuery({ kind: "dataset", id: datasetId })),
    ]);
    // The newest, which the list starts with, also when the address names a version this dataset does not have.
    const versionId = versions.find(({ id }) => id === version)?.id ?? versions.at(0)?.id;
    if (versionId !== undefined) await queryClient.ensureQueryData(fileTreeQuery(datasetId, versionId));
    return { versionId };
  },
  // Another dataset is another page, so files picked for one never show on the next.
  remountDeps: ({ params }) => params,
  component: DatasetRoute,
});

function DatasetRoute() {
  const { datasetId } = Route.useParams();
  const { versionId } = Route.useLoaderData();
  const { file } = Route.useSearch();
  return (
    <DatasetPage
      datasetId={datasetId}
      versionId={versionId}
      file={file}
    />
  );
}
