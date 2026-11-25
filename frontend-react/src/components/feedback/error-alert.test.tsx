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
import { describe, expect, it } from "vitest";
import { ErrorAlert } from "./error-alert";

describe("ErrorAlert", () => {
  it("shows the message of an error", () => {
    render(<ErrorAlert error={new Error("The dataset could not be loaded.")} />);

    expect(screen.getByRole("alert")).toHaveTextContent("The dataset could not be loaded.");
  });

  it("shows a message of the app's own", () => {
    render(<ErrorAlert error="Enter an email address." />);

    expect(screen.getByRole("alert")).toHaveTextContent("Enter an email address.");
  });

  it.each([null, undefined])("renders nothing for %s", error => {
    const { container } = render(<ErrorAlert error={error} />);

    expect(container).toBeEmptyDOMElement();
  });
});
