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

import { Link, type LinkOptions } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/**
 * Where a page is: in this app, as a route the router checks, or still in the Angular app, as a path on the same
 * site. When an area moves to React, its targets change here from the second form to the first.
 */
export type PageTarget = LinkOptions | { angularPath: string };

export interface PageLinkProps extends Omit<ComponentProps<"a">, "href"> {
  page: PageTarget;
  /** Added to the link while its page, or a page under it, is open. Only pages of this app can be. */
  activeClassName?: string;
}

/** A link to a page of either app. A page of the Angular app loads that app, which shares this one's sign-in. */
export function PageLink({ page, activeClassName, ...props }: PageLinkProps) {
  if ("angularPath" in page) {
    return (
      <a
        href={page.angularPath}
        {...props}
      />
    );
  }
  return (
    <Link
      {...page}
      activeProps={{ className: activeClassName }}
      {...props}
    />
  );
}
