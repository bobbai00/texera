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

import { SearchIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { OperatorGroup, OperatorMetadata, OperatorSchema } from "@/lib/workflow/operator-schema";
import { operatorDragType } from "../operator-drag";
import { operatorImage } from "../operator-images";

export interface OperatorMenuProps {
  metadata: OperatorMetadata;
  /** An operator type was chosen with a click or the keyboard. Dragging one onto the canvas is the canvas's to handle. */
  onAdd: (operatorType: string) => void;
}

/** Every operator type the backend offers, in its groups, with a search box. A type is dragged onto the canvas or clicked. */
export function OperatorMenu({ metadata, onAdd }: OperatorMenuProps) {
  const [search, setSearch] = useState("");
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const found = metadata.operators
    .filter(({ additionalMetadata: { userFriendlyName } }) =>
      words.every(word => userFriendlyName.toLowerCase().includes(word))
    )
    .toSorted((a, b) => a.additionalMetadata.userFriendlyName.localeCompare(b.additionalMetadata.userFriendlyName));

  return (
    <div className="space-y-3">
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search operators"
          placeholder="Search operators"
          className="pl-8"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
      </div>
      {words.length > 0 ? (
        <OperatorList
          label="Operators found"
          operators={found}
          onAdd={onAdd}
        />
      ) : (
        metadata.groups.map(group => (
          <Group
            key={group.groupName}
            group={group}
            operators={found}
            onAdd={onAdd}
          />
        ))
      )}
      {found.length === 0 && (
        <p className="px-1 text-sm text-muted-foreground">No operator matches “{search.trim()}”.</p>
      )}
    </div>
  );
}

/** A group of the menu with the groups inside it. A group that holds no operator at any depth is left out. */
function Group({
  group,
  operators,
  onAdd,
}: {
  group: OperatorGroup;
  operators: OperatorSchema[];
  onAdd: OperatorMenuProps["onAdd"];
}) {
  const own = operators.filter(operator => operator.additionalMetadata.operatorGroupName === group.groupName);
  if (!holdsAny(group, operators)) return null;

  return (
    <details
      open
      className="group/menu">
      <summary className="cursor-pointer rounded-md px-1 py-1 text-sm font-medium text-muted-foreground select-none hover:text-foreground">
        {group.groupName}
      </summary>
      {own.length > 0 && (
        <OperatorList
          label={group.groupName}
          operators={own}
          onAdd={onAdd}
        />
      )}
      <div className="ml-3">
        {group.children?.map(child => (
          <Group
            key={child.groupName}
            group={child}
            operators={operators}
            onAdd={onAdd}
          />
        ))}
      </div>
    </details>
  );
}

function holdsAny(group: OperatorGroup, operators: OperatorSchema[]): boolean {
  return (
    operators.some(operator => operator.additionalMetadata.operatorGroupName === group.groupName) ||
    (group.children ?? []).some(child => holdsAny(child, operators))
  );
}

function OperatorList({
  label,
  operators,
  onAdd,
}: {
  label: string;
  operators: OperatorSchema[];
  onAdd: OperatorMenuProps["onAdd"];
}) {
  return (
    <ul aria-label={label}>
      {operators.map(({ operatorType, additionalMetadata: { userFriendlyName, operatorDescription } }) => (
        <li key={operatorType}>
          <button
            type="button"
            draggable
            title={operatorDescription}
            onDragStart={event => {
              event.dataTransfer.setData(operatorDragType, operatorType);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAdd(operatorType)}
            className="flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground">
            <img
              src={operatorImage(operatorType)}
              alt=""
              className="size-5 shrink-0 dark:invert"
            />
            <span className="truncate">{userFriendlyName}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
