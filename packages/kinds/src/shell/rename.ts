// Changing a resource's name where it stands: a page's title, a row of a list, a chat's header.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { KeyboardEvent } from "react";
import { updateMetadata } from "../api";
import { keysOf } from "../queries";

/** Renames a resource; whatever shows it follows. */
export function useRename(rid: string, etag: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => updateMetadata(rid, { name }, etag),
    onSuccess: () => {
      for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

/** In a name's field, Enter leaves it with what was typed, Escape with the name it had. */
export const nameKeys = (name: string) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
  if (e.key === "Escape") {
    e.currentTarget.value = name;
    e.currentTarget.blur();
  }
};
