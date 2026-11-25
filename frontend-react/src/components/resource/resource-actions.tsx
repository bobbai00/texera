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

import { useQueryClient } from "@tanstack/react-query";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { can, type Resource, type ResourceDeletion } from "@/lib/resource";
import { resourceKey, resourceListKey } from "./api";
import { DeleteResourceDialog } from "./delete-resource-dialog";
import { ShareDialog } from "./share-dialog";

export interface ResourceActionsProps {
  resource: Resource;
  /** Without it, the menu has no "Delete". */
  deletion?: ResourceDeletion;
  /** Called once the resource is deleted, for its own page to leave. */
  onDeleted?: () => void | Promise<void>;
  /** In a row of a list: everything goes in the menu. On the resource's own page, "Share" is a button. */
  compact?: boolean;
}

/**
 * What the signed-in user may do with a resource of any kind: share it and delete it, each only when their
 * access allows it (see can() in lib/resource.ts). It renders nothing for a user who may do neither.
 */
export function ResourceActions({ resource, deletion, onDeleted, compact = false }: ResourceActionsProps) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"share" | "delete" | null>(null);
  const mayShare = can(resource, "share");
  const mayDelete = deletion !== undefined && can(resource, "delete");
  const shareInMenu = mayShare && compact;
  if (!mayShare && !mayDelete) return null;

  async function forgetResource() {
    // Lists of the kind load again: the one on screen now, any other when it is next opened.
    await queryClient.invalidateQueries({ queryKey: resourceListKey(resource.kind) });
    await onDeleted?.();
    // Once nothing shows the resource any more, nothing may show it from the cache either.
    queryClient.removeQueries({ queryKey: resourceKey(resource) });
  }

  return (
    <>
      {mayShare && (
        <ShareDialog
          resource={resource}
          open={dialog === "share"}
          onOpenChange={open => setDialog(open ? "share" : null)}>
          {!compact && <Button variant="outline">Share</Button>}
        </ShareDialog>
      )}
      {(shareInMenu || mayDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`More actions for ${resource.name}`}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {shareInMenu && <DropdownMenuItem onSelect={() => setDialog("share")}>Share</DropdownMenuItem>}
            {mayDelete && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDialog("delete")}>
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {mayDelete && (
        <DeleteResourceDialog
          resource={resource}
          consequence={deletion.consequence}
          onDelete={() => deletion.run(resource.id)}
          onDeleted={forgetResource}
          open={dialog === "delete"}
          onOpenChange={open => setDialog(open ? "delete" : null)}
        />
      )}
    </>
  );
}
