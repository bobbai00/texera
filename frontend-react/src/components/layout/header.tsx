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

import { Link } from "@tanstack/react-router";
import { MoonIcon, SunIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import { type Session, signOut } from "@/lib/session";
import { currentTheme, setTheme, subscribeToTheme } from "@/lib/theme";
// Texera's own mark, the peacock of its logo, from the Angular app's assets. Beside it the name is text, so it reads
// in both themes, which the logo's black lettering would not.
import texeraMark from "../../../../frontend/src/assets/logos/android-chrome-192x192.png";

/** The bar on top of every page: the way home, the theme, and the user's menu, or the way to sign in. */
export function Header({ user }: { user?: Pick<Session, "name" | "email" | "avatar"> }) {
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme);
  const otherTheme = theme === "dark" ? "light" : "dark";

  return (
    <header className="flex h-14 items-center gap-1 border-b bg-background px-4">
      <Link
        to="/"
        className="flex items-center gap-1.5 rounded-md text-lg font-semibold tracking-tight">
        <img
          src={texeraMark}
          alt=""
          className="size-8"
        />
        Texera
      </Link>
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto"
        aria-label={`Switch to ${otherTheme} theme`}
        onClick={() => setTheme(otherTheme)}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </Button>
      {!user ? (
        <Button
          asChild
          variant="outline">
          <Link to="/sign-in">Sign in</Link>
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label="Account"
              className="min-w-0">
              <UserAvatar
                name={user.name}
                picture={user.avatar}
              />
              <span className="truncate">{user.name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {user.email && <DropdownMenuLabel>{user.email}</DropdownMenuLabel>}
            {user.email && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
