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

import { useQuery } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon, EllipsisIcon, FileCodeIcon, LayoutGridIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { PagePending } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { saveText } from "@/lib/download";
import type { WorkflowContent } from "@/lib/workflow/model";
import { logicalPlan } from "@/lib/workflow/plan";
import { workflowToPython } from "../api";
import type { CardDensity } from "./workflow-canvas";

export interface WorkflowMenuProps {
  name: string;
  content: WorkflowContent;
  /** Whether the user may change the workflow, and so its layout. */
  readonly: boolean;
  /** Lays the operators out anew, each after the ones it depends on. */
  onArrange: () => void;
  /** Whether the canvas shows a small map of the whole workflow. */
  map: boolean;
  onMapChange: (map: boolean) => void;
  /** How much each operator's card says. */
  density: CardDensity;
  onDensityChange: (density: CardDensity) => void;
  /** Whether each card has its chips around it: the datasets and models it reads, and the results it kept. */
  chips: boolean;
  onChipsChange: (chips: boolean) => void;
}

// The code editor is loaded when someone first asks for the workflow as Python.
const CodeView = lazy(() => import("@/components/code/code-view").then(module => ({ default: module.CodeView })));

/**
 * What else can be done with the whole workflow: its layout, how its canvas shows it, a copy of it as a file, and it
 * as Python.
 */
export function WorkflowMenu({
  name,
  content,
  readonly,
  onArrange,
  map,
  onMapChange,
  density,
  onDensityChange,
  chips,
  onChipsChange,
}: WorkflowMenuProps) {
  const [pythonOpen, setPythonOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="More">
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!readonly && (
            <DropdownMenuItem
              disabled={content.operators.length === 0}
              onSelect={onArrange}>
              <LayoutGridIcon />
              Arrange the operators
            </DropdownMenuItem>
          )}
          <DropdownMenuCheckboxItem
            checked={map}
            onCheckedChange={onMapChange}>
            Show a map of the workflow
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={density === "detailed"}
            onCheckedChange={checked => onDensityChange(checked ? "detailed" : "compact")}>
            Show every setting on its card
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={chips}
            onCheckedChange={onChipsChange}>
            Show datasets, models and results
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => saveText(JSON.stringify(content, null, 2), `${name}.json`)}>
            <DownloadIcon />
            Download as JSON
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPythonOpen(true)}>
            <FileCodeIcon />
            Show as Python
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={pythonOpen}
        onOpenChange={setPythonOpen}>
        <DialogContent className="flex h-[80vh] max-w-4xl flex-col sm:max-w-4xl">
          {pythonOpen && (
            <PythonCode
              name={name}
              content={content}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PythonCode({ name, content }: { name: string; content: WorkflowContent }) {
  const plan = logicalPlan(content);
  const { data: code, error } = useQuery({
    queryKey: ["workflowToPython", JSON.stringify(plan)],
    queryFn: () => workflowToPython(plan),
    retry: false,
  });
  const [copied, setCopied] = useState(false);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{name} as Python</DialogTitle>
        <DialogDescription>What the workflow does, written as a script that uses pandas.</DialogDescription>
      </DialogHeader>
      <ErrorAlert error={error} />
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        {code === undefined ? (
          !error && <PagePending />
        ) : (
          <Suspense fallback={<PagePending />}>
            <CodeView
              label={`${name} as Python`}
              code={code}
              language="python"
            />
          </Suspense>
        )}
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={code === undefined}
          onClick={() => {
            if (code === undefined) return;
            void navigator.clipboard.writeText(code).then(() => setCopied(true));
          }}>
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </Button>
      </DialogFooter>
    </>
  );
}
