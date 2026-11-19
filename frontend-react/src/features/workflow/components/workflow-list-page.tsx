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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { ErrorAlert } from "@/components/feedback/error-alert";
import { resourceListKey } from "@/components/resource/api";
import { ResourceListPage } from "@/components/resource/resource-list-page";
import { Button } from "@/components/ui/button";
import { createWorkflow, workflowDeletion } from "../api";

/** The name a workflow has until its owner gives it one, as in the Angular app. */
const newWorkflowName = "Untitled workflow";

/** The workflows page: the workflows the user owns or that are shared with them, and the button to start one. */
export function WorkflowListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => createWorkflow(newWorkflowName),
    // A new workflow opens in the editor at once.
    onSuccess: async workflowId => {
      await queryClient.invalidateQueries({ queryKey: resourceListKey("workflow") });
      await navigate({ to: "/workflows/$workflowId", params: { workflowId } });
    },
  });

  return (
    <ResourceListPage
      kind="workflow"
      actions={
        <Button
          disabled={create.isPending}
          onClick={() => create.mutate()}>
          <PlusIcon />
          New workflow
        </Button>
      }
      notice={<ErrorAlert error={create.error} />}
      deletion={workflowDeletion}
      emptyDescription="Start a workflow to read, clean and analyze data, one operator after another."
    />
  );
}
