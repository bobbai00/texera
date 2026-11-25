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
import { type Claimant, heldByOthers, holderOf } from "./holds";

/** Someone in a workflow's room, editing an operator's settings from a moment on, or nothing. */
function person(clientId: number, operatorId?: string, since = 0) {
  return {
    clientId,
    name: `Person ${clientId}`,
    editing: operatorId === undefined ? undefined : { operatorId, since },
  };
}

/** What a browser of another version might say it is editing. */
const saying = (clientId: number, editing: unknown) => ({ clientId, editing }) as unknown as Claimant;

describe("holderOf", () => {
  it("is nobody while nobody edits the operator", () => {
    expect(holderOf("udf", [])).toBeUndefined();
    expect(holderOf("udf", [person(1), person(2, "limit", 50)])).toBeUndefined();
  });

  it("is whoever began editing it first, in whatever order everyone comes", () => {
    const ada = person(1, "udf", 200);
    const grace = person(2, "udf", 100);

    expect(holderOf("udf", [ada, grace])).toBe(grace);
    expect(holderOf("udf", [grace, ada])).toBe(grace);
  });

  it("goes to the lower id of two who began at the same moment, so that everyone agrees", () => {
    const ada = person(9, "udf", 100);
    const grace = person(3, "udf", 100);

    expect(holderOf("udf", [ada, grace])).toBe(grace);
    expect(holderOf("udf", [grace, ada])).toBe(grace);
  });

  it("counts nothing that does not name an operator and a moment", () => {
    const odd = [
      saying(1, "udf"),
      saying(2, null),
      saying(3, { operatorId: "udf" }),
      saying(4, { operatorId: "udf", since: "100" }),
      saying(5, { operatorId: "udf", since: Number.NaN }),
      saying(6, { operatorId: 7, since: 100 }),
    ];
    const later = person(8, "udf", 500);

    expect(holderOf("udf", odd)).toBeUndefined();
    expect(holderOf("udf", [...odd, later])).toBe(later);
  });
});

describe("heldByOthers", () => {
  it("is empty while nobody else edits anything", () => {
    expect(heldByOthers(undefined, [])).toEqual(new Map());
    expect(heldByOthers(person(1, "udf", 100), [person(2), person(3)])).toEqual(new Map());
  });

  it("has each operator that someone else holds, with whoever holds it", () => {
    const me = person(1, "limit", 10);
    const ada = person(2, "udf", 50);
    const grace = person(3, "udf", 40);
    const alan = person(4, "scan", 60);

    expect(heldByOthers(me, [ada, grace, alan])).toEqual(
      new Map([
        ["udf", grace],
        ["scan", alan],
      ])
    );
  });

  it("leaves out what this person began editing first, and has what someone else did", () => {
    const grace = person(2, "udf", 150);

    expect(heldByOthers(person(1, "udf", 100), [grace])).toEqual(new Map());
    expect(heldByOthers(person(1, "udf", 200), [grace])).toEqual(new Map([["udf", grace]]));
  });

  it("weighs this person's id like anyone's when they began at the same moment as someone else", () => {
    const grace = person(2, "udf", 100);

    expect(heldByOthers(person(1, "udf", 100), [grace])).toEqual(new Map());
    expect(heldByOthers(person(5, "udf", 100), [grace])).toEqual(new Map([["udf", grace]]));
  });

  it("is what the others hold when this person is not in the room", () => {
    const ada = person(2, "udf", 50);
    const grace = person(3, "udf", 40);

    expect(heldByOthers(undefined, [ada, grace])).toEqual(new Map([["udf", grace]]));
  });
});
