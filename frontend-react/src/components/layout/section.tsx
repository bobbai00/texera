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

import { type ReactNode, useId } from "react";
import { Card, CardContent, CardTitle } from "@/components/ui/card";

export interface SectionProps {
  title: string;
  /** The section's controls, beside its title, or under it where there is no room. */
  actions?: ReactNode;
  children: ReactNode;
}

/** A part of a page on its own surface, named by its heading. */
export function Section({ title, actions, children }: SectionProps) {
  const headingId = useId();
  return (
    <Card
      role="region"
      aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-(--card-spacing)">
        <CardTitle
          id={headingId}
          role="heading"
          aria-level={2}>
          {title}
        </CardTitle>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
