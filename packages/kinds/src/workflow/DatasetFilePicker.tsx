import { useQuery } from "@tanstack/react-query";
import { datasetsFilesOptions, datasetsListOptions } from "@texera/catalog-client/query";
import type { Dataset } from "@texera/catalog-client/types";
import { Button, Input, PopoverContent, PopoverRoot, PopoverTrigger, Skeleton, formatBytes } from "@texera/ui";
import { ChevronLeft, Database, FileText, FolderOpen, GitCommitVertical } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { versionsQuery } from "../queries";

/**
 * A dataset file reference: `dataset://<rid>@<vno>/<path>` (or the version alone). The
 * catalog resolves these to presigned URLs when the workflow runs.
 */
export const datasetFileRef = (rid: string, vno: number, path?: string) =>
  `dataset://${rid}@${vno}${path ? `/${path}` : ""}`;

export function DatasetFilePicker({
  id,
  value,
  mode,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  mode: "file" | "version";
  onChange: (path: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-1.5">
      <Input
        id={id}
        value={value}
        placeholder={mode === "file" ? "dataset://<rid>@<vno>/file.csv" : "dataset://<rid>@<vno>"}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="h-8 min-w-0 flex-1 font-mono text-2xs"
      />
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger>
          <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs" disabled={disabled}>
            <FolderOpen /> Choose
          </Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="end">
          {open && (
            <Browser
              mode={mode}
              onPick={path => {
                onChange(path);
                setOpen(false);
              }}
            />
          )}
        </PopoverContent>
      </PopoverRoot>
    </div>
  );
}

function Browser({ mode, onPick }: { mode: "file" | "version"; onPick: (path: string) => void }) {
  const { data } = useQuery(datasetsListOptions({ query: { limit: 100 } }));
  const [picked, setPicked] = useState<Dataset>();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());

  if (picked) return <Versions dataset={picked} mode={mode} onBack={() => setPicked(undefined)} onPick={onPick} />;
  const list = (data?.items ?? []).filter(d => !q || d.metadata.name.toLowerCase().includes(q));
  return (
    <div className="flex max-h-96 flex-col">
      <div className="border-b p-2">
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a dataset" className="h-8 text-xs" autoFocus />
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-1">
        {!data && <Skeleton className="m-1 h-24" />}
        {data && list.length === 0 && <p className="p-3 text-xs text-muted-foreground">No datasets.</p>}
        {list.map(d => (
          <button
            key={d.metadata.rid}
            type="button"
            onClick={() => setPicked(d)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent">
            <Database className="size-3.5 shrink-0 text-kind-dataset" />
            <span className="min-w-0 flex-1 truncate font-medium">{d.metadata.name}</span>
            <span className="truncate text-muted-foreground">v{d.metadata.headVersion}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Versions({
  dataset,
  mode,
  onBack,
  onPick,
}: {
  dataset: Dataset;
  mode: "file" | "version";
  onBack: () => void;
  onPick: (path: string) => void;
}) {
  const rid = dataset.metadata.rid;
  const { data: versions } = useQuery(versionsQuery(rid));
  const [vno, setVno] = useState<number>();
  const version = versions?.items.find(v => v.vno === vno) ?? versions?.items[0];
  const { data: files } = useQuery({
    ...datasetsFilesOptions({ path: { rid, vno: version?.vno ?? 0 } }),
    enabled: !!version && mode === "file",
  });

  return (
    <div className="flex max-h-96 flex-col">
      <div className="flex items-center gap-1 border-b p-1.5">
        <Button variant="ghost" size="icon-xs" onClick={onBack} aria-label="Back to datasets">
          <ChevronLeft />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{dataset.metadata.name}</span>
        {mode === "file" && versions && versions.items.length > 0 && (
          <select
            aria-label="Version"
            value={version?.vno}
            onChange={e => setVno(Number(e.target.value))}
            className="control h-7 px-1.5 text-xs">
            {versions.items.map(v => (
              <option key={v.vno} value={v.vno}>
                v{v.vno}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-1">
        {!versions && <Skeleton className="m-1 h-24" />}
        {versions?.items.length === 0 && <p className="p-3 text-xs text-muted-foreground">This dataset has no version yet.</p>}
        {mode === "version" &&
          versions?.items.map(v => (
            <button
              key={v.vno}
              type="button"
              onClick={() => onPick(datasetFileRef(rid, v.vno))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent">
              <GitCommitVertical className="size-3.5 text-muted-foreground" />v{v.vno}
            </button>
          ))}
        {mode === "file" &&
          version &&
          files?.files.map(f => (
            <button
              key={f.path}
              type="button"
              onClick={() => onPick(datasetFileRef(rid, version.vno, f.path))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-muted-foreground">{formatBytes(f.size)}</span>
            </button>
          ))}
      </div>
    </div>
  );
}
