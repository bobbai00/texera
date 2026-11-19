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

import { cn } from "cn";
import { DownloadIcon, FileIcon, FolderIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { type DatasetFile, type FileNode, filePath } from "../api";
import { foldersFirstThenByName } from "../files";

export interface FileTreeProps extends ComponentProps<"ul"> {
  nodes: FileNode[];
  /** With it, every file's name is a button that chooses the file: to see what is in it, or for something else. */
  onChoose?: (file: DatasetFile) => void;
  /** The path of the file that is chosen, which stands out. */
  chosen?: string;
  /** With it, every file has a button that downloads it. */
  onDownload?: (file: DatasetFile) => void;
}

// A folder's or a file's row: its icon, then its name, which is cut short rather than pushing the rest out. Sizes
// and download buttons sit at the end of the row, so they line up down the tree.
const rowClassName = "flex h-8 items-center gap-2 rounded-md px-2 hover:bg-muted/60";
const iconClassName = "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** The files and folders of a version, as nested lists, each named after its folder. */
export function FileTree({ nodes, onChoose, chosen, onDownload, className, ...props }: FileTreeProps) {
  return (
    <ul
      className={cn("text-sm", className)}
      {...props}>
      {nodes.toSorted(foldersFirstThenByName).map(node => (
        <li key={node.name}>
          {node.type === "directory" ? (
            <>
              <div className={cn(rowClassName, iconClassName)}>
                <FolderIcon />
                <span className="truncate">{node.name}</span>
              </div>
              <FileTree
                nodes={node.children}
                onChoose={onChoose}
                chosen={chosen}
                onDownload={onDownload}
                aria-label={node.name}
                className="ml-6"
              />
            </>
          ) : (
            <div
              className={cn(
                rowClassName,
                iconClassName,
                filePath(node) === chosen && "bg-accent text-accent-foreground hover:bg-accent"
              )}>
              {onChoose ? (
                <button
                  type="button"
                  aria-current={filePath(node) === chosen || undefined}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onChoose(node)}>
                  <FileIcon />
                  <span className="truncate">{node.name}</span>
                </button>
              ) : (
                <>
                  <FileIcon />
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                </>
              )}{" "}
              <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(node.size)}</span>
              {onDownload && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Download ${node.name}`}
                  onClick={() => onDownload(node)}>
                  <DownloadIcon />
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
