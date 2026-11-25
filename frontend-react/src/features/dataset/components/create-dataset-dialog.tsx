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
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formText } from "@/lib/form";
import { resourceListKey } from "@/components/resource/api";
import { createDataset } from "../api";

/** The "Create dataset" button and its dialog. A new dataset opens on its own page. */
export function CreateDatasetDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          Create dataset
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create dataset</DialogTitle>
          <DialogDescription>Add files to it once it is created.</DialogDescription>
        </DialogHeader>
        {/* The dialog renders the form only while it is open, so the form starts empty every time. */}
        <CreateDatasetForm />
      </DialogContent>
    </Dialog>
  );
}

function CreateDatasetForm() {
  const nameId = useId();
  const descriptionId = useId();
  const publicId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [nameError, setNameError] = useState<string>();
  const create = useMutation({
    mutationFn: createDataset,
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: resourceListKey("dataset") });
      await navigate({ to: "/datasets/$datasetId", params: { datasetId: id } });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = formText(form, "name");
    const problem = nameProblem(name);
    setNameError(problem);
    // A name that is refused here was not sent, so what the server said about the last one no longer applies.
    if (problem) create.reset();
    // The checkbox sends "on" only when it is checked.
    else create.mutate({ name, description: formText(form, "description"), isPublic: form.get("isPublic") === "on" });
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}>
      <FieldGroup>
        <Field data-invalid={nameError !== undefined}>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            name="name"
            required
            aria-invalid={nameError !== undefined}
          />
          <FieldError>{nameError}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
          <Textarea
            id={descriptionId}
            name="description"
          />
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={publicId}
            name="isPublic"
          />
          <FieldLabel htmlFor={publicId}>Public</FieldLabel>
        </Field>
        <ErrorAlert error={create.error} />
      </FieldGroup>
      <DialogFooter className="mt-5">
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={create.isPending}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * What is wrong with a name, by the server's rule (ResourceNaming.scala), or undefined when nothing is. The
 * rule is checked here so that a name is never changed silently to fit it.
 */
function nameProblem(name: string): string | undefined {
  if (name === "") return "Enter a name.";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) {
    return "Use only letters, numbers, hyphens, and underscores, up to 128 characters.";
  }
  return undefined;
}
