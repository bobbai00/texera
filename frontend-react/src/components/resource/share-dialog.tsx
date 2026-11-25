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
import { XIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formText } from "@/lib/form";
import { accessLabels, type Resource, type ResourceRef } from "@/lib/resource";
import {
  ownerQuery,
  resourceKey,
  resourceListKey,
  setPublic,
  type SharedAccess,
  sharedWithQuery,
  shareResource,
  unshareResource,
  visibilityQuery,
} from "./api";
import { resourceKinds } from "./kinds";

export interface ShareDialogProps {
  resource: Pick<Resource, "kind" | "id" | "name">;
  /** The button that opens the dialog. The focus goes back to it when the dialog closes. */
  children?: ReactNode;
  /** Whether the dialog is open, for a place that opens it in another way, such as a menu. Without it, the button decides. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// Only the shape of an address: whether an account has it is for the server to say.
const emailPattern = /^[^\s@]+@[^\s@]+$/;

// A row of "People with access". Its last column holds the remove button, which the owner's row does
// not have, so the badges line up.
const rowClassName = "grid h-9 grid-cols-[1fr_auto_--spacing(7)] items-center gap-2";

/** Shares a resource of any kind with people, by the email of their account, and shows who has access. */
export function ShareDialog({ resource, children, open, onOpenChange }: ShareDialogProps) {
  const { kind, id } = resource;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share {resource.name}</DialogTitle>
          <DialogDescription>Add people by the email of their Texera account.</DialogDescription>
        </DialogHeader>
        {/* The dialog renders these only while it is open, so they call the server only then. */}
        <ShareForm
          kind={kind}
          id={id}
        />
        <PeopleWithAccess
          kind={kind}
          id={id}
        />
        {resourceKinds[kind].canBePublic && (
          <Visibility
            kind={kind}
            id={id}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm(resource: ResourceRef) {
  const emailId = useId();
  const accessId = useId();
  const queryClient = useQueryClient();
  const [invalidEmail, setInvalidEmail] = useState(false);
  const share = useMutation({
    mutationFn: ({ email, access }: { email: string; access: SharedAccess }) => shareResource(resource, email, access),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharedWithQuery(resource).queryKey }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    // The email input's value comes without surrounding spaces, and the select's is one of its items.
    const email = formText(fields, "email");
    const access = formText(fields, "access") as SharedAccess;
    const valid = emailPattern.test(email);
    setInvalidEmail(!valid);
    if (valid) share.mutate({ email, access }, { onSuccess: () => form.reset() });
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="space-y-3">
      <div className="flex items-end gap-2">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            name="email"
            type="email"
            required
            aria-invalid={invalidEmail}
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor={accessId}>Access</FieldLabel>
          <Select
            name="access"
            defaultValue="view">
            <SelectTrigger id={accessId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="view">{accessLabels.view}</SelectItem>
              <SelectItem value="edit">{accessLabels.edit}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button
          type="submit"
          disabled={share.isPending}>
          Share
        </Button>
      </div>
      <ErrorAlert error={invalidEmail ? "Enter an email address, such as name@example.com." : share.error} />
    </form>
  );
}

function PeopleWithAccess(resource: ResourceRef) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const owner = useQuery(ownerQuery(resource));
  const people = useQuery(sharedWithQuery(resource));
  const unshare = useMutation({
    mutationFn: (email: string) => unshareResource(resource, email),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharedWithQuery(resource).queryKey }),
  });

  return (
    <div className="space-y-2">
      <h3
        id={headingId}
        className="font-medium">
        People with access
      </h3>
      <ErrorAlert error={owner.error ?? people.error ?? unshare.error} />
      {owner.isSuccess && people.isSuccess && (
        <ul aria-labelledby={headingId}>
          <li className={rowClassName}>
            <span className="truncate">{owner.data}</span> <Badge variant="secondary">{accessLabels.owner}</Badge>
          </li>
          {people.data.map(person => (
            <li
              key={person.email}
              className={rowClassName}>
              <span className="truncate">{person.email}</span>{" "}
              <Badge variant="outline">{accessLabels[person.access]}</Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${person.email}`}
                onClick={() => unshare.mutate(person.email)}>
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Whether anyone, signed in or not, finds the resource in the hub and may open it. */
function Visibility(resource: ResourceRef) {
  const switchId = useId();
  const queryClient = useQueryClient();
  const visibility = useQuery(visibilityQuery(resource));
  const change = useMutation({
    mutationFn: (isPublic: boolean) => setPublic(resource, isPublic),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: resourceKey(resource) }),
        queryClient.invalidateQueries({ queryKey: resourceListKey(resource.kind) }),
      ]),
  });

  // The switch is there once it is known which way it is.
  if (!visibility.isSuccess) return null;
  return (
    <div className="space-y-2 border-t pt-4">
      <ErrorAlert error={change.error} />
      <Field orientation="horizontal">
        <Checkbox
          id={switchId}
          // What was asked for shows at once, while the server makes it so.
          checked={change.isPending ? change.variables : visibility.data}
          disabled={change.isPending}
          onCheckedChange={checked => change.mutate(checked === true)}
        />
        <div>
          <FieldLabel htmlFor={switchId}>Public</FieldLabel>
          <FieldDescription>Anyone finds it in the hub and may open it, signed in or not.</FieldDescription>
        </div>
      </Field>
    </div>
  );
}
