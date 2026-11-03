import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { datasetsCommit, datasetsUnstage, datasetsUpload } from "@texera/catalog-client";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorNote,
  Input,
  Select,
  Skeleton,
  Tab,
  TabPanel,
  Tabs,
  TabsList,
  Tooltip,
  cn,
  formatBytes,
} from "@texera/ui";
import { Check, Copy, FileText, GitBranch, History, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { unwrap } from "../api";
import { versionsQuery } from "../queries";
import { KindHeader } from "../shell/KindHeader";
import { Lineage } from "../shell/Lineage";
import { metaLine } from "../shell/MetaLine";
import { Versions } from "../shell/Versions";
import type { KindViewProps } from "../types";
import { datasetFileRef } from "../workflow/DatasetFilePicker";
import { TABULAR } from "./csv";
import { datasetQuery, filesQuery, previewQuery, stagedQuery } from "./queries";

/** A dataset: the files of a version with a preview, staging and commit, versions, lineage. */
export default function DatasetView({ ref, mode }: KindViewProps) {
  const { data: dataset, error } = useQuery(datasetQuery(ref.rid));
  const [vno, setVno] = useState<number | undefined>(ref.vno);
  const [tab, setTab] = useState("files");
  if (error) return <ErrorNote error={error} prefix="Could not open this dataset" className="m-4" />;
  if (!dataset) return <Skeleton className="m-4 h-64" />;
  const head = dataset.metadata.headVersion;
  const current = vno ?? head;
  return (
    <div className="flex h-full min-h-0 flex-col" data-dataset-view={ref.rid}>
      <KindHeader
        ref={{ kind: "dataset", rid: ref.rid }}
        mode={mode}
        name={dataset.metadata.name}
        meta={metaLine(dataset.metadata, dataset.metadata.description ? [dataset.metadata.description] : [])}
        actions={head > 0 ? <VersionPicker rid={ref.rid} value={current} head={head} onChange={v => setVno(v === head ? undefined : v)} /> : undefined}
      />
      <Tabs value={tab} onValueChange={v => setTab(String(v))} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <Tab value="files">
            <FileText /> Files
          </Tab>
          <Tab value="upload">
            <Upload /> Upload
          </Tab>
          <Tab value="versions">
            <History /> Versions
          </Tab>
          <Tab value="lineage">
            <GitBranch /> Lineage
          </Tab>
        </TabsList>
        <TabPanel value="files" className="flex min-h-0 flex-1 flex-col">
          {head === 0 ? (
            <EmptyState>
              This dataset has no version yet. Upload files, then commit them as the first version.
            </EmptyState>
          ) : (
            <Files rid={ref.rid} vno={current} />
          )}
        </TabPanel>
        <TabPanel value="upload" className="scrollbar-thin overflow-y-auto">
          <Staging rid={ref.rid} onCommitted={() => setTab("files")} />
        </TabPanel>
        <TabPanel value="versions" className="scrollbar-thin overflow-y-auto">
          <Versions rid={ref.rid} head={head} selected={vno} onSelect={setVno} />
        </TabPanel>
        <TabPanel value="lineage" className="scrollbar-thin overflow-y-auto">
          <Lineage ref={{ kind: "dataset", rid: ref.rid, vno: current }} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function VersionPicker({ rid, value, head, onChange }: { rid: string; value: number; head: number; onChange: (v: number) => void }) {
  const { data } = useQuery(versionsQuery(rid));
  const options = (data?.items ?? [{ vno: head }]).map(v => ({ value: String(v.vno), label: `v${v.vno}${v.vno === head ? " (head)" : ""}` }));
  return <Select aria-label="Version" value={String(value)} onChange={v => onChange(Number(v))} options={options} className="w-32" />;
}

function Files({ rid, vno }: { rid: string; vno: number }) {
  const { data: manifest, error, isPending } = useQuery(filesQuery(rid, vno));
  const [picked, setPicked] = useState<string>();
  if (error) return <ErrorNote error={error} prefix="Could not list files" className="m-4" />;
  if (isPending) return <Skeleton className="m-4 h-32" />;
  const files = manifest.files;
  const file = files.find(f => f.path === picked) ?? files.find(f => TABULAR.test(f.path)) ?? files[0];
  if (!file) return <EmptyState>This version has no files.</EmptyState>;
  return (
    <>
      <div className="scrollbar-thin flex gap-1.5 overflow-x-auto border-b px-4 py-2">
        {files.map(f => (
          <button
            key={f.path}
            type="button"
            onClick={() => setPicked(f.path)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              f.path === file.path ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent"
            )}>
            <FileText className="size-3.5" />
            {f.path}
            <span className="opacity-60">{formatBytes(f.size)}</span>
          </button>
        ))}
      </div>
      <FilePreview rid={rid} vno={vno} path={file.path} />
    </>
  );
}

function FilePreview({ rid, vno, path }: { rid: string; vno: number; path: string }) {
  const tabular = TABULAR.test(path);
  const { data, error, isPending } = useQuery({ ...previewQuery(rid, vno, path), enabled: tabular });
  const reference = datasetFileRef(rid, vno, path);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
        <code className="min-w-0 flex-1 truncate">{reference}</code>
        <CopyButton text={reference} label="Copy the reference operators use" />
      </div>
      {!tabular ? (
        <EmptyState>No preview for this kind of file.</EmptyState>
      ) : error ? (
        <ErrorNote error={error} prefix="Could not preview this file" className="m-4" />
      ) : isPending ? (
        <Skeleton className="m-4 h-48" />
      ) : (
        <DataTable columns={data.columns} rows={data.rows} className="min-h-0 flex-1 border-t" />
      )}
    </div>
  );
}

function Staging({ rid, onCommitted }: { rid: string; onCommitted: () => void }) {
  const queryClient = useQueryClient();
  const { data: staged, isPending } = useQuery(stagedQuery(rid));
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string>();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [{ _id: "datasetsStaged", path: { rid } }] });
    queryClient.invalidateQueries({ queryKey: [{ _id: "datasetsRead", path: { rid } }] });
  };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const [i, file] of files.entries()) {
        setStatus(`Uploading ${file.name} (${i + 1} of ${files.length})`);
        await unwrap(datasetsUpload({ path: { rid, path: file.name }, body: file }));
      }
      setStatus(undefined);
    },
    onSettled: refresh,
  });
  const unstage = useMutation({
    mutationFn: (path: string) => unwrap(datasetsUnstage({ path: { rid, path } })),
    onSettled: refresh,
  });
  const commit = useMutation({
    mutationFn: () => unwrap(datasetsCommit({ path: { rid }, body: { message: message.trim() || undefined } })),
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: [{ _id: "resourcesListVersions", path: { rid } }] });
      queryClient.invalidateQueries({ queryKey: ["resource", rid] });
      refresh();
      onCommitted();
    },
  });
  const files = staged?.files ?? [];
  return (
    <div className="space-y-4 p-4" data-dataset-staging>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={e => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (picked.length) upload.mutate(picked);
          }}
        />
        <Button variant="outline" onClick={() => input.current?.click()} disabled={upload.isPending} data-upload-files>
          {upload.isPending ? <Loader2 className="animate-spin" /> : <Upload />} Add files
        </Button>
        {status && <span className="text-xs text-muted-foreground">{status}…</span>}
      </div>
      {upload.error && <ErrorNote error={upload.error} prefix="Upload failed" />}
      {isPending ? (
        <Skeleton className="h-24" />
      ) : files.length === 0 ? (
        <EmptyState className="py-6">Nothing staged. Added files wait here until you commit a version.</EmptyState>
      ) : (
        <ul className="divide-y rounded-lg border">
          {files.map(f => (
            <li key={f.path} className="flex items-center gap-2 px-3 py-2 text-sm">
              <FileText className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.path}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.path}`} onClick={() => unstage.mutate(f.path)}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input value={message} onChange={e => setMessage(e.target.value)} placeholder="Version message (optional)" className="h-8 text-xs" />
        <Button size="sm" onClick={() => commit.mutate()} disabled={files.length === 0 || commit.isPending} data-commit-version>
          {commit.isPending ? <Loader2 className="animate-spin" /> : <Check />} Commit version
        </Button>
      </div>
      {commit.error && <ErrorNote error={commit.error} prefix="Could not commit" />}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip content={copied ? "Copied" : label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={() =>
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }>
        {copied ? <Check /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

export { Badge };
