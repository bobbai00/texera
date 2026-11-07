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

export function useMay(rid: string | undefined, project = false): May {
  const { data: write } = useQuery({ ...canQuery("write", rid ?? ""), enabled: !!rid });
  const { data: remove } = useQuery({ ...canQuery("delete", rid ?? ""), enabled: !!rid });
  const { data: admin } = useQuery({ ...canQuery("admin", rid ?? ""), enabled: !!rid && project });
  return { write, delete: remove, admin };
}
