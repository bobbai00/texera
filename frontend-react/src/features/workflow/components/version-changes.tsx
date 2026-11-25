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
import { lazy, type ReactNode, Suspense, useState } from "react";
import { EmptyState } from "@/components/feedback/empty-state";
import { PagePending } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { codeLanguage, codeProperty } from "@/lib/workflow/code";
import { isUnchanged, nameOf, type OperatorChange, type ValueChange, type WorkflowDiff } from "@/lib/workflow/diff";
import type { Link, Operator } from "@/lib/workflow/model";
import type { OperatorSchema } from "@/lib/workflow/operator-schema";

export interface VersionChangesProps {
  diff: WorkflowDiff;
  /** The operator types, whose schemas name the properties. */
  schemas: Map<string, OperatorSchema>;
  /** Brings an operator on the canvas into view, and selects it. */
  onShow: (operatorId: string) => void;
}

// The code editor is loaded when someone first asks to see how code changed.
const CodeDiff = lazy(() => import("./code-editor").then(module => ({ default: module.CodeDiff })));

const fieldNames: Record<string, string> = {
  customDisplayName: "Name",
  isDisabled: "Left out of executions",
  viewResult: "Result kept",
  markedForReuse: "Result reused",
  inputPorts: "Input ports",
  outputPorts: "Output ports",
};

const settingNames: Record<string, string> = {
  dataTransferBatchSize: "Batch size",
  executionMode: "Execution mode",
};

/** What changed between the version shown and what it is compared with, operator by operator. */
export function VersionChanges({ diff, schemas, onShow }: VersionChangesProps) {
  if (isUnchanged(diff)) return <EmptyState title="Nothing changed" />;
  const { added, removed, changed, moved, addedLinks, removedLinks, comments, settings } = diff;
  const operatorNamed = (id: string) => {
    const operator = [...diff.after.operators, ...diff.before.operators].find(each => each.operatorID === id);
    return operator ? nameOf(operator) : id;
  };
  const linkName = ({ source, target }: Link) =>
    `${operatorNamed(source.operatorID)} → ${operatorNamed(target.operatorID)}`;

  return (
    <div className="space-y-5">
      <Group
        title="Added"
        mark="added"
        items={added.map(operator => (
          <OperatorItem
            key={operator.operatorID}
            operator={operator}
            onShow={onShow}
          />
        ))}
      />
      <Group
        title="Removed"
        mark="removed"
        items={removed.map(operator => (
          <OperatorItem
            key={operator.operatorID}
            operator={operator}
            onShow={onShow}
          />
        ))}
      />
      <Group
        title="Changed"
        mark="changed"
        items={changed.map(change => (
          <ChangedOperator
            key={change.operator.operatorID}
            change={change}
            schema={schemas.get(change.operator.operatorType)}
            onShow={onShow}
          />
        ))}
      />
      <Group
        title="Links"
        items={[
          ...addedLinks.map(link => <li key={`+${link.linkID}`}>Linked {linkName(link)}</li>),
          ...removedLinks.map(link => <li key={`-${link.linkID}`}>Unlinked {linkName(link)}</li>),
        ]}
      />
      <Group
        title="Moved"
        items={moved.map(id => (
          <li key={id}>
            <ShowButton
              id={id}
              onShow={onShow}>
              {operatorNamed(id)}
            </ShowButton>
          </li>
        ))}
      />
      <Group
        title="Comments"
        items={[
          ...comments.added.map(box => <li key={`+${box.commentBoxID}`}>Added: “{box.comments.at(0)?.content}”</li>),
          ...comments.changed.map(box => (
            <li key={`~${box.commentBoxID}`}>Replied to: “{box.comments.at(0)?.content}”</li>
          )),
          ...comments.removed.map(box => (
            <li key={`-${box.commentBoxID}`}>Removed: “{box.comments.at(0)?.content}”</li>
          )),
        ]}
      />
      <Group
        title="Settings"
        items={settings.map(change => (
          <ValueItem
            key={change.key}
            label={settingNames[change.key] ?? change.key}
            change={change}
          />
        ))}
      />
    </div>
  );
}

const markDots = { added: "bg-success", removed: "bg-destructive", changed: "bg-warning" };

function Group({ title, mark, items }: { title: string; mark?: keyof typeof markDots; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <section
      aria-label={title}
      className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {mark && <span className={cn("size-2 rounded-full", markDots[mark])} />}
        {title}
      </h3>
      <ul className="space-y-2 text-sm">{items}</ul>
    </section>
  );
}

function ShowButton({ id, onShow, children }: { id: string; onShow: (id: string) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
      onClick={() => onShow(id)}>
      {children}
    </button>
  );
}

function OperatorItem({ operator, onShow }: { operator: Operator; onShow: (id: string) => void }) {
  return (
    <li>
      <ShowButton
        id={operator.operatorID}
        onShow={onShow}>
        {nameOf(operator)}
      </ShowButton>
    </li>
  );
}

function ChangedOperator({
  change,
  schema,
  onShow,
}: {
  change: OperatorChange;
  schema: OperatorSchema | undefined;
  onShow: (id: string) => void;
}) {
  const { operator, properties, fields } = change;
  const language = codeLanguage(operator.operatorType);
  const label = (key: string) => {
    const property = schema?.jsonSchema.properties?.[key];
    return (typeof property === "object" && property.title) || key;
  };
  return (
    <li className="space-y-1">
      <ShowButton
        id={operator.operatorID}
        onShow={onShow}>
        {nameOf(operator)}
      </ShowButton>
      <ul className="space-y-1 border-l pl-3 text-muted-foreground">
        {fields.map(field => (
          <ValueItem
            key={field.key}
            label={fieldNames[field.key] ?? field.key}
            change={field}
          />
        ))}
        {properties.map(property =>
          property.key === codeProperty && language ? (
            <CodeItem
              key={property.key}
              name={nameOf(operator)}
              change={property}
              language={language}
            />
          ) : (
            <ValueItem
              key={property.key}
              label={label(property.key)}
              change={property}
            />
          )
        )}
      </ul>
    </li>
  );
}

function ValueItem({ label, change }: { label: string; change: ValueChange }) {
  return (
    <li>
      <span className="text-foreground">{label}</span>:{" "}
      <del className="decoration-destructive/60">{valueText(change.before)}</del> →{" "}
      <ins className="text-foreground no-underline">{valueText(change.after)}</ins>
    </li>
  );
}

function CodeItem({
  name,
  change,
  language,
}: {
  name: string;
  change: ValueChange;
  language: NonNullable<ReturnType<typeof codeLanguage>>;
}) {
  const [open, setOpen] = useState(false);
  // Code is text: a value that is not, as from a hand-made workflow, is shown as no code.
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const [before, after] = [text(change.before), text(change.after)];
  const { added, removed } = lineCounts(before, after);
  return (
    <li className="flex items-center gap-2">
      <span className="text-foreground">Code</span>
      <span>
        <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span> lines
      </span>
      <Button
        variant="link"
        size="xs"
        className="h-auto p-0"
        onClick={() => setOpen(true)}>
        Show the changes
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}>
        <DialogContent className="flex h-[80vh] max-w-6xl flex-col sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>How the code of {name} changed</DialogTitle>
            <DialogDescription>Before on the left, after on the right. Unchanged lines are folded.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
            <Suspense fallback={<PagePending />}>
              <CodeDiff
                label={`Code of ${name}`}
                before={before}
                after={after}
                language={language}
              />
            </Suspense>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** How many lines one text has that the other does not, line by line as a set. */
function lineCounts(before: string, after: string): { added: number; removed: number } {
  const [old, now] = [before.split("\n"), after.split("\n")];
  const count = (lines: string[], other: string[]) => {
    const left = new Map<string, number>();
    for (const line of other) left.set(line, (left.get(line) ?? 0) + 1);
    let missing = 0;
    for (const line of lines) {
      const times = left.get(line) ?? 0;
      if (times > 0) left.set(line, times - 1);
      else missing += 1;
    }
    return missing;
  };
  return { added: count(now, old), removed: count(old, now) };
}

/** A value as it reads in a short line: text in quotes, a list or a group of values as JSON, shortened. */
function valueText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "not set";
  const text = typeof value === "string" ? `“${value}”` : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}
