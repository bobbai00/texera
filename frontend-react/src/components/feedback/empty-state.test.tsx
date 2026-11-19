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
import { DatabaseIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("says what is missing and what to do about it, with the button that does it", () => {
    render(
      <EmptyState
        icon={DatabaseIcon}
        title="No datasets yet"
        description="Create one to upload files.">
        <button>Create dataset</button>
      </EmptyState>
    );

    expect(screen.getByText("No datasets yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to upload files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create dataset" })).toBeInTheDocument();
  });

  it("needs only a title", () => {
    const { container } = render(<EmptyState title="No files" />);

    expect(container).toHaveTextContent(/^No files$/);
  });
});
