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

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { admin, reader } from "@/testing/fixtures";
import { db } from "@/testing/mock-api";
import { addComputingUnit } from "@/testing/mock-api/execution";
import { renderApp } from "@/testing/render";
import { sessionFor } from "@/testing/session";
import { spokenText } from "@/testing/text";

describe("the computing units page of the administration", () => {
  it("lists every unit, whoever owns it, and ends someone else's", async () => {
    addComputingUnit(db, { name: "Mine" });
    addComputingUnit(db, { name: "Theirs", ownerUid: reader.uid, status: "Pending" });
    const { user } = renderApp("/admin/computing-units", { session: sessionFor(admin) });

    const list = await screen.findByRole("list", { name: "Computing units" });
    const [mine, theirs] = within(list).getAllByRole("listitem");
    expect(spokenText(mine)).toMatch(/^Mine Running texera · /);
    expect(spokenText(theirs)).toMatch(/^Theirs Pending reader · /);
    await user.click(within(list).getByRole("button", { name: "End Theirs" }));

    await waitFor(() => expect(db.computingUnits.map(unit => unit.name)).toEqual(["Mine"]));
  });
});
