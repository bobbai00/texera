// The files of a manifest kind (datasets, models): the files of a version with a preview and
// the reference operators use, and the staging area where uploads wait to be committed.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Resource } from "@texera/catalog-client/types";
import { Button, DataTable, EmptyState, ErrorNote, Input, Skeleton, Tooltip, cn, formatBytes } from "@texera/ui";
import { Check, Copy, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { keysOf } from "../queries";
import type { ResourceRef } from "../types";
import { fileUri } from "../uri";
import { fileApi, filesQuery, previewQuery, stagedQuery } from "./api";
import { TABULAR } from "./csv";

export function FilesTab({ resource, ref }: { resource: Resource; ref: ResourceRef }) {
  const head = resource.metadata.head;
  const vno = ref.vno ?? head;
  if (vno === 0) return <EmptyState>No version yet. Upload files, then commit them as the first version.</EmptyState>;
  return <Files kind={resource.kind} rid={resource.metadata.rid} vno={vno} />;
}

function Files({ kind, rid, vno }: { kind: Resource["kind"]; rid: string; vno: number }) {
  const { data: manifest, error, isPending } = useQuery(filesQuery(kind, rid, vno));
  const [picked, setPicked] = useState<string>();
  if (error) return <ErrorNote error={error} prefix="Could not list files" className="m-4" />;
  if (isPending) return <Skeleton className="m-4 h-32" />;
  const files = manifest.files;
  const file = files.find(f => f.path === picked) ?? files.find(f => TABULAR.test(f.path)) ?? files[0];
  if (!file) return <EmptyState>This version has no files.</EmptyState>;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-files>
      <div className="scrollbar-thin flex shrink-0 gap-1.5 overflow-x-auto border-b px-4 py-2">
        {files.map(f => (
          <button
            key={f.path}
            type="button"
            onClick={() => setPicked(f.path)}
            data-file={f.path}
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
      <FilePreview kind={kind} rid={rid} vno={vno} path={file.path} />
    </div>
  );
}

function FilePreview({ kind, rid, vno, path }: { kind: Resource["kind"]; rid: string; vno: number; path: string }) {
  const tabular = TABULAR.test(path);
  const { data, error, isPending } = useQuery({ ...previewQuery(kind, rid, vno, path), enabled: tabular });
  const reference = fileUri({ kind, rid, vno }, path);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground">
        <code className="min-w-0 flex-1 truncate" data-file-uri>
          {reference}
        </code>
        <CopyButton text={reference} label="Copy the URI operators use" />
      </div>
      {!tabular ? (
        <EmptyState>No preview for this kind of file.</EmptyState>
      ) : error ? (
        <ErrorNote error={error} prefix="Could not preview this file" className="m-4" />
      ) : isPending ? (
        <Skeleton className="m-4 h-48" />
      ) : (
        <>
          <DataTable columns={data.columns} rows={data.rows} className="min-h-0 flex-1 border-t" />
          {(data.rows.length < data.total || data.partial) && (
            // A preview says it is one: the first rows, of how many.
            <p className="shrink-0 border-t px-4 py-1.5 text-xs text-muted-foreground" data-preview-count>
              The first {data.rows.length} rows, of {data.partial ? `more than ${data.total}` : data.total}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function UploadTab({ resource }: { resource: Resource }) {
  const kind = resource.kind;
  const rid = resource.metadata.rid;
  const api = fileApi(kind);
  const queryClient = useQueryClient();
  const { data: staged, isPending } = useQuery(stagedQuery(kind, rid));
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<string>();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["staged", kind, rid] });
    for (const key of keysOf(rid)) queryClient.invalidateQueries({ queryKey: key });
  };
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const [i, file] of files.entries()) {
        setStatus(`Uploading ${file.name} (${i + 1} of ${files.length})`);
        await api.upload(rid, file.name, file);
      }
      setStatus(undefined);
    },
    onSettled: refresh,
  });
  const unstage = useMutation({ mutationFn: (path: string) => api.unstage(rid, path), onSettled: refresh });
  const commit = useMutation({
    mutationFn: () => api.commit(rid, message.trim() || undefined),
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["files", kind, rid] });
      refresh();
    },
  });
  const files = staged?.files ?? [];
  return (
    <div className="scrollbar-thin space-y-4 overflow-y-auto p-4" data-staging>
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
      {kind === "model" && (
        <p className="text-xs text-muted-foreground" data-contract-hint>
          Add a <code>contract.json</code> with the model's files to say what it reads and puts out; a workflow can run it once it has one.
        </p>
      )}
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

export function CopyButton({ text, label }: { text: string; label: string }) {
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
