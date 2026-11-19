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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { type ComputingUnit, resourceListKey } from "@/components/resource/api";
import { Button } from "@/components/ui/button";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formText } from "@/lib/form";
import { createComputingUnit, type NewUnit, unitOptionsQuery } from "../api";

const typeNames: Record<ComputingUnit["type"], string> = {
  kubernetes: "On the cluster",
  local: "Somewhere else, at an address",
};

/** The button that makes a computing unit, with the form that says what it is to be. */
export function CreateUnitDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon />
          New computing unit
        </Button>
      </DialogTrigger>
      <DialogContent>{open && <CreateUnitForm onCreated={() => setOpen(false)} />}</DialogContent>
    </Dialog>
  );
}

function CreateUnitForm({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient();
  const { data: options, error: optionsError } = useQuery(unitOptionsQuery());
  const [type, setType] = useState<ComputingUnit["type"]>();
  const [limits, setLimits] = useState<{ cpu?: string; memory?: string; gpu?: string }>({});
  const create = useMutation({
    mutationFn: createComputingUnit,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: resourceListKey("computing-unit") });
      onCreated();
    },
  });
  const chosenType = type ?? options?.types.at(0);
  const chosen = {
    cpu: limits.cpu ?? options?.cpu.at(0),
    memory: limits.memory ?? options?.memory.at(0),
    gpu: limits.gpu ?? options?.gpu.at(0),
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = formText(form, "name").trim();
    if (!name || !chosenType) return;
    const unit: NewUnit =
      chosenType === "kubernetes"
        ? { type: "kubernetes", name, cpu: chosen.cpu ?? "", memory: chosen.memory ?? "", gpu: chosen.gpu ?? "0" }
        : { type: "local", name, uri: formText(form, "uri").trim() };
    create.mutate(unit);
  }

  return (
    <form
      className="space-y-4"
      onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New computing unit</DialogTitle>
        <DialogDescription>Workflows are executed on it.</DialogDescription>
      </DialogHeader>
      <ErrorAlert error={optionsError ?? create.error} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="unit-name">Name</FieldLabel>
          <Input
            id="unit-name"
            name="name"
            required
            maxLength={128}
            defaultValue="My computing unit"
          />
        </Field>
        {options && options.types.length > 1 && (
          <Field>
            <FieldLabel htmlFor="unit-type">Where it runs</FieldLabel>
            <Select
              value={chosenType}
              onValueChange={value => setType(value as ComputingUnit["type"])}>
              <SelectTrigger id="unit-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {options.types.map(each => (
                  <SelectItem
                    key={each}
                    value={each}>
                    {typeNames[each]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {chosenType === "kubernetes" && options && (
          <div className="grid grid-cols-3 gap-3">
            {(["cpu", "memory", "gpu"] as const).map(limit => (
              <Field key={limit}>
                <FieldLabel htmlFor={`unit-${limit}`}>
                  {{ cpu: "CPUs", memory: "Memory", gpu: "GPUs" }[limit]}
                </FieldLabel>
                <Select
                  value={chosen[limit]}
                  onValueChange={value => setLimits({ ...limits, [limit]: value })}>
                  <SelectTrigger id={`unit-${limit}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {options[limit].map(each => (
                      <SelectItem
                        key={each}
                        value={each}>
                        {each}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ))}
          </div>
        )}
        {chosenType === "local" && (
          <Field>
            <FieldLabel htmlFor="unit-uri">Address</FieldLabel>
            <Input
              id="unit-uri"
              name="uri"
              required
              defaultValue={`${window.location.origin}/wsapi`}
            />
            <FieldDescription>Where the unit's engine listens for workflows.</FieldDescription>
          </Field>
        )}
      </FieldGroup>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button
          type="submit"
          disabled={!options || create.isPending}>
          {create.isPending ? "Making it…" : "Make it"}
        </Button>
      </DialogFooter>
    </form>
  );
}
