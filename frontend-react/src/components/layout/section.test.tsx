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

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Section } from "./section";

describe("Section", () => {
  it("is a region named by its heading, with its controls and its content", () => {
    render(
      <Section
        title="Files"
        actions={<button>Upload</button>}>
        <p>Iris.csv</p>
      </Section>
    );

    const section = screen.getByRole("region", { name: "Files" });
    expect(within(section).getByRole("heading", { level: 2, name: "Files" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Upload" })).toBeInTheDocument();
    expect(section).toHaveTextContent("Iris.csv");
  });
});
