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

import { ChevronLeftIcon, ChevronRightIcon, CopyPlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatTime } from "@/lib/format";
import type { Comparison, VersionView } from "../use-workflow-history";

export interface VersionBarProps {
  view: VersionView;
  comparison: Comparison;
  /** Whether the user may change the workflow, and so put this version back. */
  canRestore: boolean;
  /** Whether a copy of the version is being made. */
  copying: boolean;
  onComparison: (comparison: Comparison) => void;
  onOpen: (versionId: number) => void;
  onRestore: () => void;
  onCopy: () => void;
  onClose: () => void;
}

const comparisons: Record<Comparison, string> = {
  previous: "Changes from the version before",
  now: "Changes from the workflow now",
};

/** Says which version the canvas shows, steps to the one before or after it, and puts it back or copies it. */
export function VersionBar({
  view,
  comparison,
  canRestore,
  copying,
  onComparison,
  onOpen,
  onRestore,
  onCopy,
  onClose,
}: VersionBarProps) {
  const { version, older, newer } = view;
  return (
    <div
      role="toolbar"
      aria-label="Version"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted px-3 py-1.5">
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="The version before"
          disabled={!older}
          onClick={() => older && onOpen(older.id)}>
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="The version after"
          disabled={!newer}
          onClick={() => newer && onOpen(newer.id)}>
          <ChevronRightIcon />
        </Button>
      </div>
      <h2 className="text-sm font-medium">The version of {formatTime(version.savedAt)}</h2>
      <Select
        value={comparison}
        onValueChange={value => onComparison(value as Comparison)}>
        <SelectTrigger
          aria-label="Compared with"
          size="sm"
          className="max-w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {Object.entries(comparisons).map(([value, label]) => (
            <SelectItem
              key={value}
              value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={copying}
          onClick={onCopy}>
          <CopyPlusIcon />
          Make a copy
        </Button>
        {canRestore && (
          <Button
            size="sm"
            onClick={onRestore}>
            <RotateCcwIcon />
            Restore
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to the workflow"
          title="Back to the workflow"
          onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
