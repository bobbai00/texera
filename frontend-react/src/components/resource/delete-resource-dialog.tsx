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

import { useMutation } from "@tanstack/react-query";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Resource } from "@/lib/resource";

export interface DeleteResourceDialogProps {
  resource: Pick<Resource, "name">;
  /** What goes with the resource, such as "Its versions and files are deleted too." */
  consequence?: string;
  /** The call that deletes a resource of this kind. */
  onDelete: () => Promise<void>;
  /** Called once the resource is gone, to leave its page or refresh the list it was in. */
  onDeleted: () => void | Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Asks before a resource of any kind is deleted, and says why when it could not be. */
export function DeleteResourceDialog({
  resource,
  consequence,
  onDelete,
  onDeleted,
  open,
  onOpenChange,
}: DeleteResourceDialogProps) {
  const remove = useMutation({ mutationFn: onDelete, onSuccess: onDeleted });

  function handleOpenChange(next: boolean) {
    // A failure belongs to the try that made it, so it is gone when the dialog opens again.
    remove.reset();
    onOpenChange(next);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {resource.name}?</DialogTitle>
          <DialogDescription>{[consequence, "This cannot be undone."].filter(Boolean).join(" ")}</DialogDescription>
        </DialogHeader>
        <ErrorAlert error={remove.error} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
