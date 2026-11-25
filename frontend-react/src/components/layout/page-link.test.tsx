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

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/testing/render";
import { PageLink } from "./page-link";

describe("PageLink", () => {
  it("links to a page of this app through the router", () => {
    renderWithProviders(
      <PageLink
        page={{ to: "/datasets/$datasetId", params: { datasetId: 12 } }}
        className="font-medium">
        iris
      </PageLink>
    );

    const link = screen.getByRole("link", { name: "iris" });
    expect(link).toHaveAttribute("href", "/datasets/12");
    expect(link).toHaveClass("font-medium");
  });

  it("links to a page of the Angular app by its path", () => {
    renderWithProviders(<PageLink page={{ angularPath: "/user/workflow/7" }}>Iris classification</PageLink>);

    expect(screen.getByRole("link", { name: "Iris classification" })).toHaveAttribute("href", "/user/workflow/7");
  });

  it("marks the link of the page that is open", () => {
    renderWithProviders(
      <>
        <PageLink
          page={{ to: "/" }}
          activeClassName="bg-accent">
          Home
        </PageLink>
        <PageLink
          page={{ to: "/datasets" }}
          activeClassName="bg-accent">
          Datasets
        </PageLink>
      </>
    );

    expect(screen.getByRole("link", { name: "Home" })).toHaveClass("bg-accent");
    expect(screen.getByRole("link", { name: "Datasets" })).not.toHaveClass("bg-accent");
  });
});
