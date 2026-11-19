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

import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { PackageIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Page, PageHeader } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createEnvironment,
  deleteEnvironment,
  type Environment,
  environmentListQuery,
  environmentNamePattern,
  environmentsKey,
  type PackageRequirement,
  updateEnvironment,
} from "../api";

/** The environments page: the user's Python environments, each a list of packages, to make, change and delete. */
export function EnvironmentListPage() {
  const { data: environments } = useSuspenseQuery(environmentListQuery());
  // The environment being changed, or "new" for one being made.
  const [editing, setEditing] = useState<Environment | "new">();

  return (
    <Page>
      <PageHeader
        title="Environments"
        description="Python packages for your UDFs, by name, to install on a computing unit."
        actions={
          <Button onClick={() => setEditing("new")}>
            <PlusIcon />
            New environment
          </Button>
        }
      />
      {environments.length === 0 ? (
        <EmptyState
          icon={PackageIcon}
          title="No environments yet"
          description="An environment names the packages a UDF needs, such as scikit-learn==1.5."
        />
      ) : (
        <Card className="gap-0 py-0">
          <ul
            aria-label="Environments"
            className="divide-y">
            {environments.map(environment => (
              <li
                key={environment.id}
                className="flex items-center gap-3 px-4 py-3">
                <PackageIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setEditing(environment)}>
                  <span className="block truncate font-medium hover:underline">{environment.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {environment.packages.length === 0
                      ? "No packages"
                      : environment.packages.map(each => `${each.name}${each.operator}${each.version}`).join(", ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Dialog
        open={editing !== undefined}
        onOpenChange={open => !open && setEditing(undefined)}>
        <DialogContent className="sm:max-w-xl">
          {editing !== undefined && (
            <EnvironmentForm
              key={editing === "new" ? "new" : editing.id}
              environment={editing === "new" ? undefined : editing}
              onDone={() => setEditing(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

const operators: PackageRequirement["operator"][] = ["==", ">=", "<="];

function EnvironmentForm({ environment, onDone }: { environment?: Environment; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(environment?.name ?? "");
  const [packages, setPackages] = useState<PackageRequirement[]>(environment?.packages ?? []);
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: environmentsKey });
    onDone();
  };
  const save = useMutation({
    mutationFn: () => {
      const kept = packages.filter(each => each.name.trim()).map(each => ({ ...each, name: each.name.trim() }));
      return environment ? updateEnvironment({ ...environment, name, packages: kept }) : createEnvironment(name, kept);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => deleteEnvironment(environment!.id), onSuccess: done });
  const validName = environmentNamePattern.test(name);
  const change = (index: number, part: Partial<PackageRequirement>) =>
    setPackages(packages.map((each, at) => (at === index ? { ...each, ...part } : each)));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (validName) save.mutate();
  }

  return (
    <form
      className="space-y-4"
      onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{environment ? environment.name : "New environment"}</DialogTitle>
        <DialogDescription>The packages a UDF executed in this environment can import.</DialogDescription>
      </DialogHeader>
      <ErrorAlert error={save.error ?? remove.error} />
      <Field data-invalid={name !== "" && !validName}>
        <FieldLabel htmlFor="environment-name">Name</FieldLabel>
        <Input
          id="environment-name"
          value={name}
          aria-invalid={name !== "" && !validName}
          onChange={event => setName(event.target.value)}
        />
        <FieldDescription>Letters, digits, dots, dashes and underscores.</FieldDescription>
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Packages</legend>
        <ul
          aria-label="Packages"
          className="space-y-2">
          {packages.map((each, index) => (
            <li
              key={index}
              className="flex items-center gap-2">
              <Input
                aria-label="Package"
                placeholder="scikit-learn"
                value={each.name}
                onChange={event => change(index, { name: event.target.value })}
              />
              <Select
                value={each.operator}
                onValueChange={value => change(index, { operator: value as PackageRequirement["operator"] })}>
                <SelectTrigger
                  aria-label="Which versions"
                  className="w-20 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {operators.map(operator => (
                    <SelectItem
                      key={operator}
                      value={operator}>
                      {operator}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label="Version"
                placeholder="1.5.2"
                className="w-28 shrink-0"
                value={each.version}
                onChange={event => change(index, { version: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${each.name || "the package"}`}
                onClick={() => setPackages(packages.filter((_, at) => at !== index))}>
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPackages([...packages, { name: "", operator: "==", version: "" }])}>
          <PlusIcon />
          Add a package
        </Button>
      </fieldset>
      <DialogFooter className="sm:justify-between">
        {environment ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}>
            <Trash2Icon />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            disabled={!validName || save.isPending}>
            Save
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}
