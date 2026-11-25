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
import { renderWithProviders } from "@/testing/render";
import { PageHeader, PagePending } from "./page";

describe("PageHeader", () => {
  it("names the page in its only top-level heading", () => {
    renderWithProviders(<PageHeader title="Datasets" />);

    expect(screen.getByRole("heading", { level: 1, name: "Datasets" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("links to the pages above it, in this app or in the Angular app", () => {
    renderWithProviders(
      <PageHeader
        title="iris"
        parents={[
          { label: "Datasets", page: { to: "/datasets" } },
          { label: "Workflows", page: { angularPath: "/user/workflow" } },
        ]}
      />
    );

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(breadcrumb).getByRole("link", { name: "Datasets" })).toHaveAttribute("href", "/datasets");
    expect(within(breadcrumb).getByRole("link", { name: "Workflows" })).toHaveAttribute("href", "/user/workflow");
  });

  it("shows the description, the facts, the badges and the buttons it is given", () => {
    const { container } = renderWithProviders(
      <PageHeader
        title="iris"
        badges={<span>Public</span>}
        description="Iris flowers"
        meta="Owner: texera"
        actions={<button>Share</button>}
      />
    );

    expect(container).toHaveTextContent("Public");
    expect(container).toHaveTextContent("Iris flowers");
    expect(container).toHaveTextContent("Owner: texera");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });
});

describe("PagePending", () => {
  it("tells assistive technology that the page is loading", () => {
    renderWithProviders(<PagePending />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });
});
