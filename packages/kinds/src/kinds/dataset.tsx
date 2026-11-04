import { useQuery } from "@tanstack/react-query";
import type { DatasetSpec, DatasetStatus } from "@texera/catalog-client/types";
import { formatBytes } from "@texera/ui";
import { Database, FileText, Upload } from "lucide-react";
import { lazy } from "react";
import { filesQuery } from "../files/api";
import { FilesTab, UploadTab } from "../files/FilesTabs";
import { CardShell, useCardSummary } from "../shell/CardShell";
import type { KindCardProps, KindSpec } from "../types";

/** A dataset inside a chat message or a list: its files at the version in question. */
function DatasetCard({ ref, resource }: KindCardProps) {
  const { resource: r, summary } = useCardSummary(ref, resource);
  const vno = ref.vno ?? r?.metadata.head;
  const { data } = useQuery({ ...filesQuery("dataset", ref.rid, vno ?? 0), enabled: !!vno });
  const files = data?.files ?? [];
  const size = files.reduce((sum, f) => sum + f.size, 0);
  // The card has the manifest, so its facts come from it rather than from the envelope's status.
  const facts = vno ? [`v${vno}`, ...(data ? [`${files.length} file${files.length === 1 ? "" : "s"}`, formatBytes(size)] : [])] : ["no version yet"];
  return (
    <CardShell ref={ref} summary={summary && { ...summary, facts }}>
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

export const datasetKind: KindSpec = {
  kind: "dataset",
  label: "Dataset",
  plural: "Datasets",
  icon: Database,
  accent: "bg-kind-dataset/12 text-kind-dataset",
  Card: lazy(() => Promise.resolve({ default: DatasetCard })),
  tabs: [
    { value: "files", label: "Files", icon: FileText, Component: FilesTab },
    { value: "upload", label: "Upload", icon: Upload, Component: UploadTab },
  ],
  defaultSpec: () => ({}) satisfies DatasetSpec,
  facts: r => {
    const status = r.status as DatasetStatus | undefined;
    return [
      r.metadata.head > 0 ? `v${r.metadata.head}` : "no version yet",
      ...(status?.files !== undefined ? [`${status.files} file${status.files === 1 ? "" : "s"}`] : []),
      ...(status?.staged ? [`${status.staged} staged`] : []),
    ];
  },
};
