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

// A workflow's versions. The backend keeps the workflow as it is saved now, and for each save that changed it, a
// JSON patch (RFC 6902) that turns what that save saved back into what was saved before it
// (WorkflowVersionResource.scala). Every version is rebuilt here, from the saved workflow back through the
// patches. The backend's own rebuilding of a version (GET /version/{wid}/{vid}) applies one patch too many and
// gives the version before the one asked for, so the app does not use it.

import { applyPatch, type Operation } from "fast-json-patch";
import { contentOf, type WorkflowContent } from "./model";

/** A version as the backend lists it (VersionEntry). Its content is the patch, as JSON in a string. */
export interface VersionRecord {
  vId: number;
  /** In epoch milliseconds. */
  creationTime: number;
  content: string;
}

/** What one save of a workflow saved, and when. */
export interface WorkflowVersion {
  id: number;
  /** In epoch milliseconds. */
  savedAt: number;
  content: WorkflowContent;
}

export interface WorkflowHistory {
  /** Newest first: the first is the workflow as it is saved now. */
  versions: WorkflowVersion[];
  /** Whether every version could be rebuilt. A patch that does not fit, as after a migration, ends it there. */
  complete: boolean;
}

/** Saves close together that are read as one stretch of work. */
export interface WorkflowSession {
  /** Newest first. */
  versions: WorkflowVersion[];
  /** The version just before the session, which its changes lead from. None for the first session. */
  before?: WorkflowVersion;
}

/** Every version of a workflow, from its saved content (as the backend sends it) and the backend's versions. */
export function historyOf(savedContent: string, records: VersionRecord[]): WorkflowHistory {
  const newestFirst = records.toSorted((a, b) => b.vId - a.vId);
  const versions: WorkflowVersion[] = [];
  let saved = JSON.parse(savedContent) as Partial<WorkflowContent>;
  for (const [index, record] of newestFirst.entries()) {
    versions.push({ id: record.vId, savedAt: record.creationTime, content: contentOf(saved) });
    // The oldest patch leads to before the workflow was made, which is no version.
    if (index === newestFirst.length - 1) break;
    try {
      saved = applyPatch(saved, JSON.parse(record.content) as Operation[], true, false).newDocument;
    } catch {
      return { versions, complete: false };
    }
  }
  return { versions, complete: true };
}

/** Versions, newest first, in sessions: each saved within `gapMs` of the one before it is in the same session. */
export function sessionsOf(versions: WorkflowVersion[], gapMs: number): WorkflowSession[] {
  const sessions: WorkflowSession[] = [];
  for (const version of versions) {
    const current = sessions.at(-1);
    const newer = current?.versions.at(-1);
    if (current && newer && newer.savedAt - version.savedAt <= gapMs) current.versions.push(version);
    else {
      if (current) current.before = version;
      sessions.push({ versions: [version] });
    }
  }
  return sessions;
}
