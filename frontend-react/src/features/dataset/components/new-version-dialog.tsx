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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formText } from "@/lib/form";
import { formatBytes } from "@/lib/format";
import type { Resource } from "@/lib/resource";
import { publicSettingsQuery } from "@/components/settings/api";
import { createVersion, datasetQuery, maxFileSize, uploadFile } from "../api";

export interface NewVersionDialogProps {
  /** The dataset the files go to. */
  dataset: Resource;
  /** Called with the id of the version made of the uploaded files. */
  onVersionCreated: (versionId: number) => void;
}

/** The "New version" button and its dialog, which closes once the version is made. */
export function NewVersionDialog({ dataset, onVersionCreated }: NewVersionDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UploadIcon />
          New version
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New version of {dataset.name}</DialogTitle>
          <DialogDescription>
            Each file is uploaded as soon as it is added. The version holds the files that arrived, with the
            dataset&apos;s other files.
          </DialogDescription>
        </DialogHeader>
        {/* The dialog renders the form only while it is open, so the form starts empty every time. */}
        <NewVersionForm
          dataset={dataset}
          onVersionCreated={versionId => {
            setOpen(false);
            onVersionCreated(versionId);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** A file being added, and how its upload went. */
type Upload = { file: File } & ({ status: "uploading" | "uploaded" } | { status: "failed"; message: string });

function NewVersionForm({ dataset, onVersionCreated }: NewVersionDialogProps) {
  const descriptionId = useId();
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const create = useMutation({
    mutationFn: (description: string) => createVersion(dataset.id, description),
    onSuccess: async ({ id }) => {
      // The dataset's key covers its versions and their files.
      await queryClient.invalidateQueries({ queryKey: datasetQuery(dataset.id).queryKey });
      onVersionCreated(id);
    },
  });
  const ready =
    uploads.some(upload => upload.status === "uploaded") && uploads.every(upload => upload.status !== "uploading");

  // Uploads stop when the form goes away, as on closing the dialog, leaving the page, or when another user signs
  // in: a file that arrived later would wait, unseen, for the next version anyone makes.
  const uploadsSignal = useRef<AbortSignal>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    uploadsSignal.current = controller.signal;
    return () => controller.abort();
  }, []);

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.currentTarget.files ?? [])];
    // So that picking the same file again uploads it again.
    event.currentTarget.value = "";
    setUploads(current => [...current, ...files.map(file => ({ file, status: "uploading" as const }))]);
    for (const file of files) {
      const settle = (upload: Upload) =>
        setUploads(current => current.map(other => (other.file === file ? upload : other)));
      addFile(file).then(
        () => settle({ file, status: "uploaded" }),
        (error: Error) => settle({ file, status: "failed", message: error.message })
      );
    }
  }

  /** Uploads a file, after refusing in plain words what the server would refuse in its own terms. */
  async function addFile(file: File) {
    if (file.size === 0) throw new Error("This file is empty.");
    const largest = maxFileSize(await queryClient.fetchQuery(publicSettingsQuery()));
    if (file.size > largest) throw new Error(`Files can be at most ${formatBytes(largest)}.`);
    await uploadFile(dataset, file, uploadsSignal.current);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(formText(new FormData(event.currentTarget), "description"));
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        {/* The file input covers the whole box, so a click or a drop anywhere on it adds files. */}
        <div className="relative flex flex-col items-center gap-1 rounded-lg border border-dashed p-6 text-center text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 hover:bg-muted/50 has-disabled:opacity-50">
          <UploadIcon
            aria-hidden
            className="size-5 text-muted-foreground"
          />
          <span className="font-medium">Add files</span>
          <span className="text-muted-foreground">Choose files, or drop them here</span>
          {/* Making a version closes the form, so a file picked meanwhile would be uploaded without one. */}
          <input
            type="file"
            multiple
            aria-label="Add files"
            disabled={create.isPending}
            onChange={handleFiles}
            className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
        </div>
        {uploads.length > 0 && (
          <ul
            aria-label="Uploads"
            className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
            {/* Rows are only added at the end, so an index is a stable key. */}
            {uploads.map((upload, index) => (
              <li
                key={index}
                className="flex items-center justify-between gap-4 px-3 py-2">
                <span className="truncate">{upload.file.name}</span>{" "}
                {upload.status === "failed" ? (
                  <span
                    role="alert"
                    className="text-destructive">
                    Failed: {upload.message}
                  </span>
                ) : (
                  // A status, so that screen readers say when the upload is done.
                  <span
                    role="status"
                    className="shrink-0 text-muted-foreground">
                    {upload.status === "uploading" ? "Uploading…" : "Uploaded"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <Field>
          <FieldLabel htmlFor={descriptionId}>Version description</FieldLabel>
          <Input
            id={descriptionId}
            name="description"
            placeholder="Optional"
          />
        </Field>
        <ErrorAlert error={create.error} />
      </FieldGroup>
      <DialogFooter className="mt-5">
        <Button
          type="submit"
          disabled={!ready || create.isPending}>
          Create version
        </Button>
      </DialogFooter>
    </form>
  );
}
