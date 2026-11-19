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

import { describe, expect, it } from "vitest";
import history from "@/testing/fixtures/workflow-history.json";
import { recordsOf } from "@/testing/mock-api/workflow";
import { link, operator, workflowContent } from "@/testing/workflow";
import { emptyContent, type WorkflowContent } from "./model";
import { historyOf, sessionsOf, type WorkflowVersion } from "./versions";

const first = workflowContent([operator("CSVFileScan", "scan")]);
const second = workflowContent([operator("CSVFileScan", "scan"), operator("Limit", "limit")], [link("scan", "limit")]);
const third = { ...second, operatorPositions: { ...second.operatorPositions, limit: { x: 50, y: 50 } } };

describe("historyOf", () => {
  it("rebuilds every version, newest first, each as it was saved", () => {
    const saves: [number, WorkflowContent][] = [
      [1000, first],
      [2000, second],
      [3000, third],
    ];

    const { versions, complete } = historyOf(JSON.stringify(third), recordsOf(saves));

    expect(versions.map(version => [version.savedAt, version.content])).toEqual([
      [3000, third],
      [2000, second],
      [1000, first],
    ]);
    expect(complete).toBe(true);
  });

  it("rebuilds the versions a Texera backend keeps, from its own patches", () => {
    const { versions, complete } = historyOf(history.content, history.versions);

    expect(complete).toBe(true);
    expect(versions.map(version => version.id)).toEqual([681, 680, 679, 678, 677, 676, 675]);
    expect(versions.map(version => version.content.operators.length)).toEqual([5, 5, 4, 3, 2, 1, 0]);
    expect(versions.map(version => version.content.commentBoxes.length)).toEqual([1, 0, 0, 0, 0, 0, 0]);
    // The first version is the workflow as it was made: empty, with the backend's settings.
    expect(versions.at(-1)?.content).toMatchObject({ operators: [], links: [], settings: emptyContent.settings });
  });

  it("keeps the versions it could rebuild when an older patch does not fit", () => {
    const records = recordsOf([
      [1000, first],
      [2000, second],
      [3000, third],
    ]);
    // A patch from another history: it removes an operator that is not there.
    records[1] = { ...records[1], content: JSON.stringify([{ op: "remove", path: "/operators/7" }]) };

    const { versions, complete } = historyOf(JSON.stringify(third), records);

    expect(versions.map(version => version.savedAt)).toEqual([3000, 2000]);
    expect(complete).toBe(false);
  });

  it("has only the saved workflow when the backend lists no version, and reads an old workflow's gaps", () => {
    const { versions } = historyOf(JSON.stringify({ operators: [] }), []);

    expect(versions).toEqual([]);
    expect(historyOf('{"operators": []}', recordsOf([[1000, first]])).versions[0].content.links).toEqual([]);
  });
});

describe("sessionsOf", () => {
  const at = (minute: number, id = minute): WorkflowVersion => ({ id, savedAt: minute * 60_000, content: first });

  it("puts versions saved close together in one session, newest first", () => {
    const versions = [at(100), at(98), at(90), at(30), at(29), at(5)];

    const sessions = sessionsOf(versions, 15 * 60_000);

    expect(sessions.map(session => session.versions.map(version => version.id))).toEqual([
      [100, 98, 90],
      [30, 29],
      [5],
    ]);
    // Each session's changes lead from the version before it, which is the first of the next one.
    expect(sessions[0].before?.id).toBe(30);
    expect(sessions[2].before).toBeUndefined();
  });

  it("has no sessions without versions", () => {
    expect(sessionsOf([], 60_000)).toEqual([]);
  });
});
