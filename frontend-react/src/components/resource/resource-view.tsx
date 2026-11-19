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

import { LayoutGridIcon, ListIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ResourceView } from "./resource-list";

/** Switches a list between a row and a card for each resource. */
export function ResourceViewSwitch({ view, onChange }: { view: ResourceView; onChange: (view: ResourceView) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      aria-label="View"
      value={view}
      // The view that is on stays on when it is pressed again: a list always has one.
      onValueChange={value => value && onChange(value as ResourceView)}>
      <ToggleGroupItem
        value="list"
        aria-label="List"
        title="List">
        <ListIcon />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="cards"
        aria-label="Cards"
        title="Cards">
        <LayoutGridIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
