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

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import type { ResourceVersion } from "@/lib/resource";

export interface VersionSelectProps {
  /** Newest first. */
  versions: ResourceVersion[];
  selectedId: number;
  onSelect: (id: number) => void;
}

/** Picks one of the versions of a resource of any kind. Each is listed with the date it was made. */
export function VersionSelect({ versions, selectedId, onSelect }: VersionSelectProps) {
  return (
    <Select
      value={String(selectedId)}
      onValueChange={id => onSelect(Number(id))}>
      <SelectTrigger
        aria-label="Version"
        className="max-w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="end">
        {versions.map(version => (
          <SelectItem
            key={version.id}
            value={String(version.id)}>
            <span className="truncate">{version.name}</span>{" "}
            <span className="text-xs text-muted-foreground">{formatDate(version.createdAt)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
