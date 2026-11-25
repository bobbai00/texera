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

import type { ReactNode } from "react";
import type { Session } from "@/lib/session";
import { Header } from "./header";
import { type NavigationGroup, Sidebar } from "./sidebar";

export interface ShellProps {
  /** Who is signed in: nobody, on a page anyone may open, such as the hub's. */
  user?: Pick<Session, "name" | "email">;
  navigation: NavigationGroup[];
  children: ReactNode;
}

/** The frame of a page that fills the window by itself, such as an editor: the header, and the page in all the rest. */
export function FullPageShell({ user, children }: Pick<ShellProps, "user" | "children">) {
  return (
    <div className="flex h-svh flex-col">
      <Header user={user} />
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

/** The frame of the other pages: the header, the navigation, and the page in the rest. */
export function Shell({ user, navigation, children }: ShellProps) {
  return (
    <div className="flex min-h-svh flex-col">
      <Header user={user} />
      {/* On a phone the navigation goes above the page, which then keeps the whole width of the screen. */}
      <div className="flex flex-1 flex-col md:flex-row">
        <Sidebar navigation={navigation} />
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
