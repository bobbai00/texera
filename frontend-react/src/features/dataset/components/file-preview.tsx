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

import { useQuery } from "@tanstack/react-query";
import { DownloadIcon, FileIcon, FileQuestionIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PagePending } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import { type DatasetFile, filePreviewQuery } from "../api";
import { previewLimits } from "../file-kinds";
import type { FilePreview as Preview } from "../preview";

// What text and Markdown are drawn with is loaded when the first is shown: most files are tables.
const CodeView = lazy(() => import("@/components/code/code-view").then(module => ({ default: module.CodeView })));
const MarkdownView = lazy(() => import("./markdown-view").then(module => ({ default: module.MarkdownView })));

export interface FilePreviewProps {
  datasetId: number;
  file: DatasetFile;
  onDownload: (file: DatasetFile) => void;
}

/**
 * What is in a file of a dataset, shown as its kind is best read: a table of its rows, its text highlighted, its
 * Markdown formatted, its page, image, video, sound or PDF. Of a big text, only its start is read and shown, which
 * the preview says. A file that cannot be shown is downloaded instead.
 */
export function FilePreview({ datasetId, file, onDownload }: FilePreviewProps) {
  const { data: preview, error } = useQuery(filePreviewQuery(datasetId, file));
  const part = preview && partShown(preview, file);
  return (
    <Card
      role="region"
      aria-label={`Preview of ${file.name}`}
      className="h-160 min-w-0 flex-1 gap-0 py-0">
      <div className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        <FileIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <h3 className="min-w-0 truncate font-medium">{file.name}</h3>
        <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => onDownload(file)}>
          <DownloadIcon />
          Download
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <ErrorAlert error={error} />
          </div>
        ) : preview ? (
          <Suspense fallback={<PagePending />}>
            <PreviewOf
              file={file}
              preview={preview}
            />
          </Suspense>
        ) : (
          <PagePending />
        )}
      </div>
      {part && <p className="shrink-0 border-t px-4 py-2 text-sm text-muted-foreground">{part}</p>}
    </Card>
  );
}

/** What part of a file is shown, when it is not all of it. */
function partShown(preview: Preview, file: DatasetFile): string | undefined {
  if (!("whole" in preview) || preview.whole) return undefined;
  if (preview.kind === "table") return `The first ${preview.rows.length.toLocaleString("en-US")} rows.`;
  return `The first ${formatBytes(previewLimits.text)} of ${formatBytes(file.size)}.`;
}

function PreviewOf({ file, preview }: { file: DatasetFile; preview: Preview }): ReactNode {
  switch (preview.kind) {
    case "table":
      return (
        <TableView
          label={`Rows of ${file.name}`}
          columns={preview.columns}
          rows={preview.rows}
        />
      );
    case "text":
      return (
        <CodeView
          label={`Text of ${file.name}`}
          code={preview.text}
          language={preview.language}
          wrap={preview.wrap}
        />
      );
    case "markdown":
      return (
        <MarkdownView
          label={`Text of ${file.name}`}
          text={preview.text}
        />
      );
    case "html":
      return (
        // A page of a dataset is shown apart from the app: it may run its own scripts, and nothing of the app's.
        <iframe
          title={`Page of ${file.name}`}
          sandbox="allow-scripts"
          srcDoc={preview.text}
          className="size-full"
        />
      );
    case "pdf":
      return (
        <PdfView
          title={`PDF of ${file.name}`}
          pdf={preview.pdf}
        />
      );
    case "image":
    case "video":
    case "audio":
      return (
        <MediaView
          name={file.name}
          kind={preview.kind}
          url={preview.url}
        />
      );
    case "none":
      return (
        <EmptyState
          icon={FileQuestionIcon}
          title={preview.reason === "binary" ? "No preview of this kind of file" : "Too big to preview"}
          description="Download it to open it with an app that reads it."
        />
      );
  }
}

/** Rows as a table whose header stays in view, each numbered, with a long value cut short and whole on hover. */
function TableView({ label, columns, rows }: { label: string; columns: string[]; rows: string[][] }) {
  return (
    // The preview scrolls the table both ways, so its header stays at the top: the table's own frame does not.
    <div className="[&_[data-slot=table-container]]:overflow-visible">
      <Table aria-label={label}>
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-0 text-right text-muted-foreground">#</TableHead>
            {columns.map((column, index) => (
              <TableHead key={index}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              <TableCell className="text-right text-muted-foreground tabular-nums">{index + 1}</TableCell>
              {row.map((cell, column) => (
                <TableCell
                  key={column}
                  title={cell}
                  className="max-w-80 truncate">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** A PDF, in the browser's own viewer. Its link is made when the frame is drawn, and let go when it is taken away. */
function PdfView({ title, pdf }: { title: string; pdf: Blob }) {
  const show = useCallback(
    (frame: HTMLIFrameElement | null) => {
      if (!frame) return;
      const url = URL.createObjectURL(pdf);
      frame.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [pdf]
  );
  return (
    <iframe
      ref={show}
      title={title}
      className="size-full"
    />
  );
}

/** An image, a video or a sound, which the browser streams from the file's link as it shows it. */
function MediaView({ name, kind, url }: { name: string; kind: "image" | "video" | "audio"; url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <EmptyState
        icon={FileQuestionIcon}
        title="This browser cannot show this file"
        description="Download it to open it with an app that reads it."
      />
    );
  }
  const fail = () => setFailed(true);
  return (
    <div className="flex size-full items-center justify-center bg-muted p-4">
      {kind === "image" ? (
        <img
          src={url}
          alt={name}
          onError={fail}
          className="max-h-full max-w-full object-contain"
        />
      ) : kind === "video" ? (
        <video
          src={url}
          controls
          preload="metadata"
          aria-label={name}
          onError={fail}
          className="max-h-full max-w-full"
        />
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          aria-label={name}
          onError={fail}
          className="w-full max-w-md"
        />
      )}
    </div>
  );
}
