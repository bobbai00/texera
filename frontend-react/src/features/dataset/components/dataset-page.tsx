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

import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderOpenIcon } from "lucide-react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page } from "@/components/layout/page";
import { Section } from "@/components/layout/section";
import { ResourceActions } from "@/components/resource/resource-actions";
import { ResourcePageHeader } from "@/components/resource/resource-page-header";
import { VersionSelect } from "@/components/resource/version-select";
import { can } from "@/lib/resource";
import { datasetDeletion, datasetQuery, downloadDatasetFile, filePath, fileTreeQuery, versionListQuery } from "../api";
import { filesInOrder, firstFileOf, pathInVersion } from "../files";
import { FilePreview } from "./file-preview";
import { FileTree } from "./file-tree";
import { NewVersionDialog } from "./new-version-dialog";

export interface DatasetPageProps {
  datasetId: number;
  /** The version to show, which the route picks: the one in the address, or else the newest. None without versions. */
  versionId?: number;
  /** The file to show what is in, by its path in the version, as the address names it. */
  file?: string;
}

/**
 * A dataset's page: the files of one of its versions, with what is in the one chosen, and for those who may change
 * it, sharing and new versions.
 */
export function DatasetPage({ datasetId, versionId, file }: DatasetPageProps) {
  const navigate = useNavigate();
  const { data: dataset } = useSuspenseQuery(datasetQuery(datasetId));
  const { data: versions } = useSuspenseQuery(versionListQuery(datasetId));
  const mayEdit = can(dataset, "edit");

  // Another version shows the same file, where it has one.
  function showVersion(id: number) {
    void navigate({ to: "/datasets/$datasetId", params: { datasetId }, search: { version: id, file } });
  }
  // A file is shown in the version the address names, or in the newest, whichever that is then.
  function showFile(path: string) {
    void navigate({ to: "/datasets/$datasetId", params: { datasetId }, search: search => ({ ...search, file: path }) });
  }

  return (
    <Page>
      <ResourcePageHeader
        resource={dataset}
        actions={
          <ResourceActions
            resource={dataset}
            deletion={datasetDeletion}
            onDeleted={() => navigate({ to: "/datasets" })}
          />
        }
      />
      <Section
        title="Files"
        actions={
          <>
            {versionId !== undefined && (
              <VersionSelect
                versions={versions}
                selectedId={versionId}
                onSelect={showVersion}
              />
            )}
            {mayEdit && (
              <NewVersionDialog
                dataset={dataset}
                onVersionCreated={showVersion}
              />
            )}
          </>
        }>
        {versionId === undefined ? (
          <EmptyState
            icon={FolderOpenIcon}
            title="No versions yet"
            description={mayEdit ? "Add files to make the first version." : undefined}
          />
        ) : (
          <VersionFiles
            datasetId={datasetId}
            versionId={versionId}
            file={file}
            onFile={showFile}
          />
        )}
      </Section>
    </Page>
  );
}

/**
 * The files of a version, and what is in the one chosen: the one the address names, or else the version's README,
 * or its first file. A file's own button downloads it.
 */
function VersionFiles({
  datasetId,
  versionId,
  file,
  onFile,
}: {
  datasetId: number;
  versionId: number;
  file?: string;
  onFile: (path: string) => void;
}) {
  const { data: nodes } = useSuspenseQuery(fileTreeQuery(datasetId, versionId));
  const download = useMutation({ mutationFn: downloadDatasetFile });

  if (nodes.length === 0) return <EmptyState title="This version has no files" />;
  // Every path in a version starts with the version's own folder, which the address leaves out.
  const root = nodes[0].parentDir;
  const shown = filesInOrder(nodes).find(each => pathInVersion(each, root) === file) ?? firstFileOf(nodes);
  return (
    <div className="@container space-y-3">
      <ErrorAlert error={download.error} />
      <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-start">
        {/* The rows' own padding goes outside the section's, so their icons start under its title. */}
        <FileTree
          aria-label="Files"
          nodes={nodes}
          chosen={shown && filePath(shown)}
          onChoose={chosen => onFile(pathInVersion(chosen, root))}
          onDownload={download.mutate}
          className="-mx-2 @3xl:w-72 @3xl:shrink-0"
        />
        {shown && (
          <FilePreview
            datasetId={datasetId}
            file={shown}
            onDownload={download.mutate}
          />
        )}
      </div>
    </div>
  );
}
