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
import { useSession } from "@/app/use-session";
import { publicWorkflowQuery } from "@/features/hub/api";
import { PublicWorkflowPage } from "@/features/hub/components/public-workflow-page";
import { operatorMetadataQuery } from "@/features/workflow/api";
import { WorkflowView } from "@/features/workflow/components/workflow-view";

export const Route = createFileRoute("/hub/workflows/$workflowId")({
  params: {
    parse: ({ workflowId }) => (/^\d+$/.test(workflowId) ? { workflowId: Number(workflowId) } : false),
    stringify: ({ workflowId }) => ({ workflowId: String(workflowId) }),
  },
  loader: ({ context: { queryClient }, params: { workflowId } }) =>
    Promise.all([
      queryClient.ensureQueryData(publicWorkflowQuery(workflowId)),
      queryClient.ensureQueryData(operatorMetadataQuery()),
    ]),
  // A workflow that is not public, or no longer is, is no page here.
  errorComponent: () => <p className="text-muted-foreground">This workflow is not public.</p>,
  component: PublicWorkflowRoute,
});

// The page is two features: the hub's, which says what the workflow is and copies it, and the workflow's, which
// draws it. Each gets what it needs here.
function PublicWorkflowRoute() {
  const { workflowId } = Route.useParams();
  const navigate = Route.useNavigate();
  const session = useSession();
  const { data: workflow } = useSuspenseQuery(publicWorkflowQuery(workflowId));
  const { data: metadata } = useSuspenseQuery(operatorMetadataQuery());
  return (
    <PublicWorkflowPage
      workflow={workflow}
      signedIn={session !== null}
      onCloned={id => void navigate({ to: "/workflows/$workflowId", params: { workflowId: id } })}>
      <div className="flex h-[70vh] min-h-0">
        <WorkflowView
          content={workflow.content}
          metadata={metadata}
        />
      </div>
    </PublicWorkflowPage>
  );
}
