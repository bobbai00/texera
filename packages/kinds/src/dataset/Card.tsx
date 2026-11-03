import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "@texera/ui";
import { FileText } from "lucide-react";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps } from "../types";
import { filesQuery } from "./queries";

/** A dataset inside a chat message or a list: its files at the version in question. */
export default function DatasetCard({ ref, resource }: KindCardProps) {
  const { summary } = useCardSummary(ref, resource);
  const vno = ref.vno ?? resource?.metadata.headVersion;
  const { data } = useQuery({ ...filesQuery(ref.rid, vno ?? 0), enabled: !!vno });
  const files = data?.files ?? [];
  const size = files.reduce((sum, f) => sum + f.size, 0);
  return (
    <CardShell
      ref={ref}
      summary={
        summary && {
          ...summary,
          facts: [...(summary.facts ?? []), ...(data ? [`${files.length} file${files.length === 1 ? "" : "s"}`, formatBytes(size)] : [])],
        }
      }>
      {files.length > 0 && (
        <ul className="divide-y px-3 text-xs">
          {files.slice(0, 5).map(f => (
            <li key={f.path} className="flex items-center gap-2 py-1.5">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
            </li>
          ))}
          {files.length > 5 && <li className="py-1.5 text-muted-foreground">and {files.length - 5} more</li>}
        </ul>
      )}
    </CardShell>
  );
}
