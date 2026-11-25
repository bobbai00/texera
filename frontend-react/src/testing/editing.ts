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

import { useMemo, useState, useSyncExternalStore } from "react";
import type { WorkflowEditing } from "@/features/workflow/use-workflow-editing";
import type { PortSchemas } from "@/lib/workflow/compilation";
import { WorkflowDocument, writeContent } from "@/lib/workflow/document";
import type { WorkflowContent } from "@/lib/workflow/model";
import type { OperatorMetadata } from "@/lib/workflow/operator-schema";
import { type Collaborator, WorkflowRoom } from "@/lib/workflow/room";

export interface LocalEditingOptions {
  /** What the workflow holds when it opens. */
  content: WorkflowContent;
  metadata: OperatorMetadata;
  /** The others the editor shows in the room, as presence would tell of them: what they select and edit. */
  collaborators?: Collaborator[];
  /** The columns that arrive at each input port of each operator, as compiling the workflow would say. */
  inputSchemas?: PortSchemas;
  /** Why each operator that cannot be executed cannot, by its id, as compiling and checking it would say. */
  problems?: Record<string, string>;
}

const nobody: Collaborator[] = [];
const none = {};

/**
 * A workflow open for editing in this page alone, as a story opens the editor: in a document of its own, filled with
 * `content` as the shared editing service fills one, and with a room that is never entered. So nothing is sent, saved
 * or compiled, no socket is opened, and the only others in the room are those it is told of. What the editor changes,
 * it changes in the document, and shows as it shows what the room holds. It imports nothing that only a test can load,
 * such as Vitest, Testing Library or the fake backend.
 */
export function useLocalEditing({
  content,
  metadata,
  collaborators = nobody,
  inputSchemas = none,
  problems = none,
}: LocalEditingOptions): WorkflowEditing {
  const [document] = useState(() => {
    const filled = new WorkflowDocument();
    writeContent(filled.doc, content);
    return filled;
  });
  const [room] = useState(() => new WorkflowRoom(document, 1, "texera"));
  const live = useSyncExternalStore(document.subscribe, document.content);
  const history = useSyncExternalStore(document.subscribe, document.history);
  const schemas = useMemo(() => new Map(metadata.operators.map(schema => [schema.operatorType, schema])), [metadata]);
  return {
    entry: "entered",
    offline: false,
    save: "saved",
    collaborators,
    document,
    room,
    content: live,
    history,
    schemas,
    inputSchemas,
    problems,
    lostOfflineChanges: false,
    acknowledgeLostChanges: () => {},
  };
}
