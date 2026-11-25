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

import { GlobeIcon, LockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { accessLabels, can, type Resource } from "@/lib/resource";

/**
 * Whether anyone signed in may view the resource, or only the people it is shared with. Nothing is shown where
 * the backend did not say.
 */
export function VisibilityBadge({ resource }: { resource: Pick<Resource, "isPublic"> }) {
  if (resource.isPublic === undefined) return null;
  return resource.isPublic ? (
    <Badge variant="secondary">
      <GlobeIcon />
      Public
    </Badge>
  ) : (
    <Badge variant="outline">
      <LockIcon />
      Private
    </Badge>
  );
}

/** What the signed-in user may do with the resource. Nothing is shown for a resource they may not even view. */
export function AccessBadge({ resource }: { resource: Pick<Resource, "access"> }) {
  if (!can(resource, "view")) return null;
  return <Badge variant="outline">{accessLabels[resource.access]}</Badge>;
}
