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

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Resource } from "@/lib/resource";
import { renderWithProviders } from "@/testing/render";
import { ResourcePageHeader } from "./resource-page-header";

const iris: Resource = {
  kind: "dataset",
  id: 12,
  name: "iris",
  description: "Iris flowers",
  owner: "ada@example.com",
  isPublic: true,
  createdAt: Date.UTC(2026, 10, 12, 12),
  access: "edit",
};

describe("ResourcePageHeader", () => {
  it("shows the resource's name, description, visibility, owner and date, and what the user may do with it", () => {
    const { container } = renderWithProviders(<ResourcePageHeader resource={iris} />);

    expect(screen.getByRole("heading", { level: 1, name: "iris" })).toBeInTheDocument();
    expect(container).toHaveTextContent("Iris flowers");
    expect(container).toHaveTextContent("Public");
    expect(container).toHaveTextContent("Can edit");
    expect(container).toHaveTextContent("Owner: ada@example.com · Created Nov 12, 2026");
  });

  it("links to the list of the resource's kind", () => {
    renderWithProviders(<ResourcePageHeader resource={iris} />);

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Datasets" })).toHaveAttribute("href", "/datasets");
  });

  it("shows the page's buttons, and no badge for what the server did not say", () => {
    const { container } = renderWithProviders(
      <ResourcePageHeader
        resource={{ ...iris, kind: "workflow", isPublic: undefined, access: "owner" }}
        actions={<button>Run</button>}
      />
    );

    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Public|Private/);
    expect(container).toHaveTextContent("Owner");
  });
});
