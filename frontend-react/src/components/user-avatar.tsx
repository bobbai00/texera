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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export interface UserAvatarProps {
  /** Their name, or their email where that is all the backend says of them. */
  name: string;
  /** Where their picture is. Without one, or until it loads, their initials stand in for it. */
  picture?: string;
  /** Classes of the disc the initials are on, such as a collaborator's color. By default it is the app's own. */
  className?: string;
}

/**
 * Someone, as a small disc: their picture, or their initials. It is drawn beside their name, which says who they
 * are to a screen reader, so the disc says nothing.
 */
export function UserAvatar({ name, picture, className }: UserAvatarProps) {
  return (
    <Avatar
      size="sm"
      aria-hidden>
      {picture && (
        <AvatarImage
          src={picture}
          alt=""
          // Google serves a picture only to a request that does not say where it comes from.
          referrerPolicy="no-referrer"
        />
      )}
      <AvatarFallback className={cn("bg-primary/10 font-medium text-primary", className)}>
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** One or two letters for a name: of its first and its last word, or of an email before its @. */
function initialsOf(name: string): string {
  const words = name
    .split("@")[0]
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? `${words[0].charAt(0)}${words.at(-1)!.charAt(0)}` : (words[0]?.charAt(0) ?? "");
  return letters.toUpperCase() || "?";
}
