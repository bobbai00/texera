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

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDelayed } from "@/components/use-delayed";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { inputSchemas, noCompilation, type PortSchemas } from "@/lib/workflow/compilation";
import { type History, WorkflowDocument } from "@/lib/workflow/document";
import type { WorkflowContent } from "@/lib/workflow/model";
import type { OperatorMetadata, OperatorSchema } from "@/lib/workflow/operator-schema";
import { logicalPlan } from "@/lib/workflow/plan";
import { type RoomState, WorkflowRoom } from "@/lib/workflow/room";
import { columnProblems, operatorProblems } from "@/lib/workflow/validation";
import { compile } from "./api";

/** A workflow that is open for editing: what is on its canvas now, and what the app knows about it. */
export interface WorkflowEditing extends RoomState {
  /** Every change to the workflow is made through its document. */
  document: WorkflowDocument;
  /** The room the workflow is edited in: it is told where this user is, for the others to see. */
  room: WorkflowRoom;
  content: WorkflowContent;
  history: History;
  /** Each operator type the backend offers, by its name. */
  schemas: Map<string, OperatorSchema>;
  /** The columns that arrive at each input port of each operator, as the compiling service last said. */
  inputSchemas: PortSchemas;
  /** Why each operator that cannot be executed cannot, by its id. An execution needs this to be empty. */
  problems: Record<string, string>;
  /**
   * The workflow was opened again as it is saved, without what this user had changed while offline: the room
   * had been filled anew by the time they were back. The user is told once.
   */
  lostOfflineChanges: boolean;
  /** The user has been told. */
  acknowledgeLostChanges: () => void;
}

/** A document, and the room it follows. Together they are one lineage: see writeContent() in document.ts. */
function openSession(workflowId: number, userName: string) {
  const document = new WorkflowDocument();
  return { document, room: new WorkflowRoom(document, workflowId, userName) };
}

/** How long after the last change the workflow is compiled. */
const compileDelayMs = 400;

/**
 * Opens a workflow for editing, together with whoever else has it open. The workflow comes from its room on the
 * shared editing service, which also saves it; here its changes are compiled as they come.
 */
export function useWorkflowEditing(workflowId: number, metadata: OperatorMetadata, userName: string): WorkflowEditing {
  const [{ document, room }, setSession] = useState(() => openSession(workflowId, userName));
  const [lostOfflineChanges, setLostOfflineChanges] = useState(false);
  useEffect(() => {
    room.enter();
    const stop = room.subscribe(() => {
      // A document of an earlier filling of the room cannot go back into it: the user starts again with what
      // the room holds now, and is told if that leaves out something they had changed.
      if (room.state().entry !== "outdated") return;
      if (room.hasUnsent()) setLostOfflineChanges(true);
      setSession(openSession(workflowId, userName));
    });
    return () => {
      stop();
      room.leave();
    };
  }, [room, workflowId, userName]);
  const roomState = useSyncExternalStore(room.subscribe, room.state);
  const content = useSyncExternalStore(document.subscribe, document.content);
  const history = useSyncExternalStore(document.subscribe, document.history);
  const schemas = useMemo(() => new Map(metadata.operators.map(schema => [schema.operatorType, schema])), [metadata]);

  const invalid = useMemo(() => operatorProblems(content, schemas), [content, schemas]);
  // Only the operators that are complete are compiled: the service refuses a plan with a value of the wrong type.
  const plan = useMemo(
    () =>
      logicalPlan({ ...content, operators: content.operators.filter(operator => !(operator.operatorID in invalid)) }),
    [content, invalid]
  );
  const planKey = useDelayed(JSON.stringify(plan), compileDelayMs);
  const { data: compilation = noCompilation } = useQuery({
    queryKey: ["compilation", planKey],
    queryFn: () => compile(JSON.parse(planKey) as typeof plan),
    enabled: plan.operators.length > 0,
    // The last answer stands until the next one is there, so the column choices do not come and go.
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  const arriving = useMemo(() => inputSchemas(content.links, compilation.outputSchemas), [content.links, compilation]);
  const problems = useMemo(
    () => ({ ...compilation.errors, ...columnProblems(content, schemas, arriving), ...invalid }),
    [compilation, content, schemas, arriving, invalid]
  );

  return {
    ...roomState,
    document,
    room,
    content,
    history,
    schemas,
    inputSchemas: arriving,
    problems,
    lostOfflineChanges,
    acknowledgeLostChanges: () => setLostOfflineChanges(false),
  };
}
