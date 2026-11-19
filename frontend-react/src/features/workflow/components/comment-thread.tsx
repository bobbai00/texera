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
import { PencilIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { formatTime } from "@/lib/format";
import type { CommentRef } from "@/lib/workflow/document";
import type { Comment } from "@/lib/workflow/model";

export interface CommentThreadProps {
  /** The comments of the box, first to last. A comment that is being started has none. */
  comments: Comment[];
  /** The signed-in user, who may change and remove their own comments. */
  userId: number;
  /** Whether the user may comment, which is whether they may change the workflow. */
  canComment: boolean;
  onAdd: (content: string) => void;
  onEdit: (comment: CommentRef, content: string) => void;
  onRemove: (comment: CommentRef) => void;
  /** Gives up a comment that is being started. */
  onClose: () => void;
}

/** A comment box's thread: who said what, and when, with a place to reply, or the first comment of a new box. */
export function CommentThread({ comments, userId, canComment, onAdd, onEdit, onRemove, onClose }: CommentThreadProps) {
  const [editing, setEditing] = useState<CommentRef>();
  const starting = comments.length === 0;

  return (
    <div>
      {!starting && (
        <ol className="space-y-4 p-4">
          {comments.map(comment => {
            const key = `${comment.creatorID}/${comment.creationTime}`;
            const own = canComment && comment.creatorID === userId;
            const isEditing = editing && `${editing.creatorID}/${editing.creationTime}` === key;
            return (
              <li
                key={key}
                className="group space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <UserAvatar name={comment.creatorName} />
                  <span className="truncate font-medium">{comment.creatorName}</span>
                  <time
                    dateTime={comment.creationTime}
                    className="truncate text-muted-foreground">
                    {formatTime(comment.creationTime)}
                  </time>
                  {own && !isEditing && (
                    <span className="ml-auto flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Edit your comment"
                        onClick={() => setEditing(comment)}>
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete your comment"
                        onClick={() => onRemove(comment)}>
                        <Trash2Icon />
                      </Button>
                    </span>
                  )}
                </div>
                {isEditing ? (
                  <CommentForm
                    initial={comment.content}
                    label="Save"
                    onSubmit={content => {
                      onEdit(comment, content);
                      setEditing(undefined);
                    }}
                    onCancel={() => setEditing(undefined)}
                  />
                ) : (
                  <p className="pl-8 text-sm whitespace-pre-wrap">{comment.content}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {canComment && !editing && (
        <div className={cn("p-4", !starting && "border-t")}>
          <CommentForm
            // The form starts empty again after each comment.
            key={comments.length}
            label={starting ? "Comment" : "Reply"}
            autoFocus={starting}
            onSubmit={onAdd}
            onCancel={starting ? onClose : undefined}
          />
        </div>
      )}
    </div>
  );
}

/** A place to write a comment, sent with its button or with Ctrl or ⌘ and Enter. */
function CommentForm({
  initial = "",
  label,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  label: string;
  autoFocus?: boolean;
  onSubmit: (content: string) => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const content = text.trim();

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (content) onSubmit(content);
  }
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
    if (event.key === "Escape") onCancel?.();
  }

  return (
    <form
      className="space-y-2"
      onSubmit={submit}>
      <Textarea
        aria-label={label === "Save" ? "Your comment" : "Write a comment"}
        placeholder={label === "Reply" ? "Reply…" : "Write a comment…"}
        value={text}
        // A comment that is being started is written at once.
        autoFocus={autoFocus}
        onChange={event => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={!content}>
          {label}
        </Button>
      </div>
    </form>
  );
}
