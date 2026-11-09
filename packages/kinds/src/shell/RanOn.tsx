import { useQuery } from "@tanstack/react-query";
import { cn } from "@texera/ui";
import { resourceByUriQuery } from "../queries";
import { versionOf } from "../uri";

/** A resource's name, and the version its URI pins: `python-default v1`; empty without a URI. */
export function useNamed(uri: string | undefined): string {
  const { data } = useQuery({ ...resourceByUriQuery(uri ?? ""), enabled: !!uri });
  if (!uri) return "";
  const vno = versionOf(uri);
  return `${data?.metadata.name ?? "…"}${vno !== undefined ? ` v${vno}` : ""}`;
}

/** A resource by its name, and the version its URI pins. */
export function Named({ uri }: { uri: string }) {
  return (
    <span className="font-medium text-foreground" title={uri}>
      {useNamed(uri)}
    </span>
  );
}

interface Where {
  unit?: string;
  profile?: string;
  warehouse?: string;
}

/** Where an execution ran, as one sentence: `on texera-unit (python-default v1) · results in platform`; empty when nothing says. */
export function useRanOn({ unit, profile, warehouse }: Where): { said: string; names: Record<keyof Where, string> } {
  const names = { unit: useNamed(unit), profile: useNamed(profile), warehouse: useNamed(warehouse) };
  const said = [
    unit ? `on ${names.unit}${profile ? ` (${names.profile})` : ""}` : "",
    warehouse ? `results in ${names.warehouse}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { said, names };
}

/**
 * Where an execution runs and keeps its results, in words: `on texera-unit (python-default v1)
 * · results in platform`, the whole of it on hover where it is cut short. The unit and the
 * warehouse are no cards of a workflow's lineage; this is how it says them.
 */
export function RanOn({ unit, profile, warehouse, className }: Where & { className?: string }) {
  const { said, names } = useRanOn({ unit, profile, warehouse });
  if (!unit && !warehouse) return null;
  return (
    <span className={cn("min-w-0 truncate text-muted-foreground", className)} title={said} data-ran-on>
      {unit && (
        <>
          on <span className="font-medium text-foreground">{names.unit}</span>
          {profile && (
            <>
              {" "}
              (<span className="font-medium text-foreground">{names.profile}</span>)
            </>
          )}
        </>
      )}
      {unit && warehouse && " · "}
      {warehouse && (
        <>
          results in <span className="font-medium text-foreground">{names.warehouse}</span>
        </>
      )}
    </span>
  );
}
