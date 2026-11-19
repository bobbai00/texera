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

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, DatabaseIcon, FileIcon, FolderOpenIcon } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { VersionSelect } from "@/components/resource/version-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Resource } from "@/lib/resource";
import { filePath, fileTreeQuery, readableDatasetsQuery, versionListQuery } from "../api";
import { FileTree } from "./file-tree";

export interface DatasetPathPickerProps {
  /** The id that the field's label points to. */
  id: string;
  /** What is picked: a file of a version of a dataset, or a version as a whole. */
  pick: "file" | "version";
  /** The path of what is picked, such as /dataset/ada@uci.edu/penguins/v1/2024/adelie.csv. Empty when nothing is. */
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
}

/** What a path names: /dataset/<owner's email>/<dataset>/<version>, then the file's path in the version. */
function parsePath(path: string): { owner?: string; dataset?: string; version?: string; file?: string } {
  const [owner, dataset, version, ...file] = path.split("/").filter(part => part !== "" && part !== "dataset");
  return { owner, dataset, version, file: file.length > 0 ? file.join("/") : undefined };
}

/**
 * A field that holds the path of a file in a dataset, or of a version of one. The path is the server's own name
 * for it, so it is picked from the user's datasets, not typed, and the field shows what it names: a file by its name,
 * under its dataset and version. The whole path shows on hover.
 */
export function DatasetPathPicker({ id, pick, value, disabled, onChange }: DatasetPathPickerProps) {
  const [open, setOpen] = useState(false);
  const what = pick === "file" ? "file" : "dataset version";
  const chosen = parsePath(value);
  const [name, detail] =
    pick === "file"
      ? [chosen.file?.split("/").at(-1), [chosen.dataset, chosen.version].filter(Boolean).join(" · ")]
      : [chosen.dataset, chosen.version];
  const shownId = useId();
  const Icon = pick === "file" ? FileIcon : DatabaseIcon;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          title={value || undefined}
          aria-describedby={shownId}
          className="h-auto min-h-9 w-full justify-start gap-2.5 py-1.5 text-left font-normal">
          <Icon className="text-muted-foreground" />
          <span
            id={shownId}
            className="min-w-0 flex-1">
            {name ? (
              <>
                <span className="block truncate">{name}</span>
                {detail && <span className="block truncate text-muted-foreground">{detail}</span>}
              </>
            ) : (
              <span className="text-muted-foreground">Choose a {what}</span>
            )}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a {what}</DialogTitle>
          <DialogDescription>
            {pick === "file" ? "A file of one of your datasets." : "A version of one of your datasets."}
          </DialogDescription>
        </DialogHeader>
        <DatasetBrowser
          pick={pick}
          current={parsePath(value)}
          onPick={path => {
            onChange(path);
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The datasets the user may read, then the versions and the files of the one they open, to pick from. */
function DatasetBrowser({
  pick,
  current,
  onPick,
}: {
  pick: "file" | "version";
  current: ReturnType<typeof parsePath>;
  onPick: (path: string) => void;
}) {
  const [search, setSearch] = useState("");
  const readable = useQuery(readableDatasetsQuery());
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const datasets = (readable.data ?? [])
    .filter(each => words.every(word => `${each.name} ${each.description}`.toLowerCase().includes(word)))
    .toSorted((a, b) => b.createdAt - a.createdAt);
  /** The dataset the user opened, or "none" once they have gone back to the list. */
  const [opened, setOpened] = useState<Resource | "none">();
  // Until the user opens one themselves, the dataset that is chosen now is open.
  const dataset =
    opened === "none"
      ? undefined
      : (opened ?? readable.data?.find(each => each.owner === current.owner && each.name === current.dataset));

  if (dataset) {
    return (
      <DatasetVersions
        pick={pick}
        dataset={dataset}
        currentVersion={current.version}
        onBack={() => setOpened("none")}
        onPick={onPick}
      />
    );
  }
  return (
    <div className="space-y-3">
      <Input
        type="search"
        aria-label="Search datasets"
        placeholder="Search by name or description"
        value={search}
        onChange={event => setSearch(event.target.value)}
      />
      <ErrorAlert error={readable.error} />
      {readable.isPending ? (
        <Skeleton className="h-24" />
      ) : datasets.length === 0 ? (
        <EmptyState
          icon={DatabaseIcon}
          title="No datasets found"
          description="Files are read from datasets. Create one and upload a file to it first."
        />
      ) : (
        <ul
          aria-label="Datasets"
          className="max-h-80 space-y-1 overflow-y-auto">
          {datasets.map(each => (
            <li key={each.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                onClick={() => setOpened(each)}>
                <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{each.name}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{each.owner}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One dataset: its versions, and the files of the version that is shown. */
function DatasetVersions({
  pick,
  dataset,
  currentVersion,
  onBack,
  onPick,
}: {
  pick: "file" | "version";
  dataset: Resource;
  currentVersion?: string;
  onBack: () => void;
  onPick: (path: string) => void;
}) {
  const versions = useQuery(versionListQuery(dataset.id));
  const [versionId, setVersionId] = useState<number>();
  // The version that is chosen now is shown first; without one, the newest.
  const version =
    versions.data?.find(each => each.id === versionId) ??
    versions.data?.find(each => each.name === currentVersion) ??
    versions.data?.at(0);
  const files = useQuery({ ...fileTreeQuery(dataset.id, version?.id ?? 0), enabled: version !== undefined });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to the datasets"
          onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <h3 className="truncate text-sm font-medium">{dataset.name}</h3>
        <div className="ml-auto">
          {version && versions.data && (
            <VersionSelect
              versions={versions.data}
              selectedId={version.id}
              onSelect={setVersionId}
            />
          )}
        </div>
      </div>
      <ErrorAlert error={versions.error ?? files.error} />
      {versions.data?.length === 0 ? (
        <EmptyState
          icon={FolderOpenIcon}
          title="No versions yet"
          description="Upload files to this dataset and make a version of them first."
        />
      ) : !files.data ? (
        <Skeleton className="h-24" />
      ) : (
        <FileTree
          aria-label="Files"
          nodes={files.data}
          className="max-h-80 overflow-y-auto"
          // A file's path is its folder's, which the server gives, and its name.
          onChoose={pick === "file" ? file => onPick(filePath(file)) : undefined}
        />
      )}
      {pick === "version" && version && (
        <Button onClick={() => onPick(`/dataset/${dataset.owner}/${dataset.name}/${version.name}`)}>
          Choose this version
        </Button>
      )}
    </div>
  );
}

type PathPickerProps = Omit<DatasetPathPickerProps, "pick">;

/** Picks a file of a dataset: what an operator that reads a file is given. */
export function DatasetFilePicker(props: PathPickerProps) {
  return (
    <DatasetPathPicker
      pick="file"
      {...props}
    />
  );
}

/** Picks a version of a dataset, as a whole. */
export function DatasetVersionPicker(props: PathPickerProps) {
  return (
    <DatasetPathPicker
      pick="version"
      {...props}
    />
  );
}
