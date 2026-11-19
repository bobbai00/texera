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

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useSession } from "@/app/use-session";
import { FullPageShell } from "@/components/layout/shell";
import { DatasetFilePicker, DatasetVersionPicker } from "@/features/dataset/components/dataset-path-picker";
import { ExecuteToHereItem, ExecutionControls } from "@/features/execution/components/execution-controls";
import { ExecutionHistory } from "@/features/execution/components/execution-history";
import { ExecutionPanel } from "@/features/execution/components/execution-panel";
import { useExecution } from "@/features/execution/use-execution";
import { operatorMetadataQuery, workflowQuery } from "@/features/workflow/api";
import { WorkflowEditor } from "@/features/workflow/components/workflow-editor";
import { useWorkflowEditing } from "@/features/workflow/use-workflow-editing";

export const Route = createFileRoute("/_signed-in/workflows/$workflowId")({
  params: {
    // A workflow id is a number; any other address is not found.
    parse: ({ workflowId }) => (/^\d+$/.test(workflowId) ? { workflowId: Number(workflowId) } : false),
    stringify: ({ workflowId }) => ({ workflowId: String(workflowId) }),
  },
  // A version of the workflow is shown in its place: ?version=681.
  validateSearch: (search: Record<string, unknown>): { version?: number } => {
    const version = Number(search.version);
    return Number.isInteger(version) && version > 0 ? { version } : {};
  },
  loader: ({ context: { queryClient }, params: { workflowId } }) =>
    Promise.all([
      queryClient.ensureQueryData(workflowQuery(workflowId)),
      queryClient.ensureQueryData(operatorMetadataQuery()),
    ]),
  // Another workflow is another editor: nothing of one may show in the next.
  remountDeps: ({ params }) => params,
  component: WorkflowRoute,
});

// An operator that reads a file is given one of a dataset's: the editor gets the way to pick it from datasets.
const propertyControls = { datasetFile: DatasetFilePicker, datasetVersion: DatasetVersionPicker };

function WorkflowRoute() {
  const { workflowId } = Route.useParams();
  const { version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const session = useSession();
  const { data: workflow } = useSuspenseQuery(workflowQuery(workflowId));
  const { data: metadata } = useSuspenseQuery(operatorMetadataQuery());
  // The page is two features side by side: editing the workflow, and executing it. Each is given what it needs
  // of the other here, so that neither knows the other.
  const editing = useWorkflowEditing(workflowId, metadata, session?.name ?? "");
  const execution = useExecution(workflowId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  if (!session) return null;
  const { content, problems } = editing;
  const operatorNames = Object.fromEntries(
    content.operators.map(each => [each.operatorID, each.customDisplayName ?? each.operatorID])
  );
  const showVersion = (id: number | undefined) => void navigate({ search: id === undefined ? {} : { version: id } });

  return (
    <FullPageShell user={session}>
      <WorkflowEditor
        workflow={workflow}
        metadata={metadata}
        editing={editing}
        user={{ id: session.userId, name: session.name }}
        progress={execution.snapshot.operators}
        propertyControls={propertyControls}
        operatorItems={operator => (
          <ExecuteToHereItem
            execution={execution}
            content={content}
            problems={problems}
            operatorId={operator.operatorID}
          />
        )}
        version={version}
        onVersion={showVersion}
        executions={
          <ExecutionHistory
            workflowId={workflowId}
            canChange={!workflow.readonly}
            operatorNames={operatorNames}
            state={execution.snapshot.state}
            onOpenVersion={showVersion}
          />
        }
        onCopied={id => void navigate({ to: "/workflows/$workflowId", params: { workflowId: id }, search: {} })}
        onSelect={setSelectedIds}
        toolbar={
          <ExecutionControls
            execution={execution}
            content={content}
            executable={Object.keys(problems).length === 0}
          />
        }
        panel={
          <ExecutionPanel
            client={execution.client}
            snapshot={execution.snapshot}
            operatorNames={operatorNames}
            operatorId={selectedIds.at(0)}
          />
        }
      />
    </FullPageShell>
  );
}
