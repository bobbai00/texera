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

import type { LucideIcon } from "lucide-react";
import { PageLink, type PageTarget } from "./page-link";

/** A part of the main navigation: a few pages under one heading. */
export interface NavigationGroup {
  label: string;
  items: { label: string; icon: LucideIcon; page: PageTarget }[];
}

/** The main navigation of every signed-in page: a column beside the page, or a row above it on a phone. */
export function Sidebar({ navigation }: { navigation: NavigationGroup[] }) {
  return (
    <nav
      aria-label="Main"
      className="shrink-0 overflow-x-auto border-b bg-sidebar p-3 md:w-56 md:space-y-4 md:overflow-x-visible md:border-r md:border-b-0">
      {/* On a phone the groups run on as one row, without their headings. */}
      <div className="flex gap-1 md:block md:space-y-4">
        {navigation.map(group => (
          <ul
            key={group.label}
            aria-label={group.label}
            className="flex gap-1 md:block md:space-y-0.5">
            <li
              aria-hidden
              className="hidden px-3 pb-1 text-xs font-medium text-muted-foreground md:block">
              {group.label}
            </li>
            {group.items.map(({ label, icon: Icon, page }) => (
              <li key={label}>
                <PageLink
                  page={page}
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap hover:bg-accent hover:text-accent-foreground"
                  activeClassName="bg-accent text-accent-foreground">
                  <Icon
                    aria-hidden
                    className="size-4 text-muted-foreground"
                  />
                  {label}
                </PageLink>
              </li>
            ))}
          </ul>
        ))}
      </div>
    </nav>
  );
}
