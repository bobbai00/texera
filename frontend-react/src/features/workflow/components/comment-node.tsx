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

import type { Node, NodeProps } from "@xyflow/react";
import { cn } from "cn";
import { MessageSquareTextIcon } from "lucide-react";
import type { Comment } from "@/lib/workflow/model";

export interface CommentNodeData extends Record<string, unknown> {
  /** The comments of the box, first to last. A comment that is being written has none yet. */
  comments: Comment[];
}

export type CommentNodeType = Node<CommentNodeData, "comment">;

/** A comment box on the canvas, as a note: who started it, what they said, and how many have replied. */
export function CommentNode({ data: { comments }, selected }: NodeProps<CommentNodeType>) {
  const [first, ...replies] = comments;
  return (
    <div
      className={cn(
        "w-56 rounded-lg border border-warning/40 bg-warning/10 p-3 text-card-foreground shadow-xs backdrop-blur-sm",
        selected && "border-ring ring-3 ring-ring/50"
      )}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareTextIcon className="size-4 shrink-0 text-warning" />
        <span className="truncate font-medium text-foreground">{first ? first.creatorName : "New comment"}</span>
        {replies.length > 0 && (
          <span className="ml-auto shrink-0">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </span>
        )}
      </div>
      {first && <p className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap">{first.content}</p>}
    </div>
  );
}
