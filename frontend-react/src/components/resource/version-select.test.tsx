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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VersionSelect } from "./version-select";

const versions = [
  { id: 3, name: "v2 - add notes", createdAt: Date.UTC(2026, 10, 14, 12) },
  { id: 2, name: "v1", createdAt: Date.UTC(2026, 10, 13, 12) },
];

describe("VersionSelect", () => {
  it("shows the selected version", () => {
    render(
      <VersionSelect
        versions={versions}
        selectedId={2}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole("combobox", { name: "Version" })).toHaveTextContent("v1 Nov 13, 2026");
  });

  it("lists the versions in the order given, each with the date it was made", async () => {
    const user = userEvent.setup();
    render(
      <VersionSelect
        versions={versions}
        selectedId={3}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Version" }));

    const options = await screen.findAllByRole("option");
    expect(options.map(option => option.textContent)).toEqual(["v2 - add notes Nov 14, 2026", "v1 Nov 13, 2026"]);
  });

  it("reports the version that is chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <VersionSelect
        versions={versions}
        selectedId={3}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Version" }));
    await user.click(await screen.findByRole("option", { name: /^v1 / }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  });
});
