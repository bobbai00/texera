// What a person may do to a resource, as the catalog decides it for them: a page offers only
// that. Undefined while the catalog is being asked; a page shows nothing that changes or
// removes until it has said yes.

import { useQuery } from "@tanstack/react-query";
import { canQuery } from "../queries";

export interface May {
  write?: boolean;
  delete?: boolean;
  /** For a project: whether the person is one of its admins, who change the project itself. */
  admin?: boolean;
}

/** A person's role on a project, as its page says it; undefined while the catalog is asked. */
export type Role = "admin" | "member" | "viewer";

/** What a person is on a project: an admin changes the project, a member works in it, a viewer reads it. */
export function roleOf(may: May): Role | undefined {
  if (may.admin === undefined || may.write === undefined) return undefined;
  if (may.admin) return "admin";
  return may.write ? "member" : "viewer";
}

export function useMay(rid: string | undefined, project = false): May {
  const { data: write } = useQuery({ ...canQuery("write", rid ?? ""), enabled: !!rid });
  const { data: remove } = useQuery({ ...canQuery("delete", rid ?? ""), enabled: !!rid });
  const { data: admin } = useQuery({ ...canQuery("admin", rid ?? ""), enabled: !!rid && project });
  return { write, delete: remove, admin };
}
