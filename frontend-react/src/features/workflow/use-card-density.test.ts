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

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCardDensity } from "./use-card-density";

const key = "texera.workflowCanvas.density";

describe("useCardDensity", () => {
  it("says each operator's settings in one line until the viewer chooses otherwise, and keeps their choice", () => {
    const { result, unmount } = renderHook(() => useCardDensity());
    expect(result.current[0]).toBe("compact");

    act(() => result.current[1]("detailed"));

    expect(result.current[0]).toBe("detailed");
    expect(localStorage.getItem(key)).toBe('"detailed"');
    unmount();
    expect(renderHook(() => useCardDensity()).result.current[0]).toBe("detailed");
  });

  it.each(['"sideways"', "42", "{}", "not JSON"])("reads what it cannot use, %s, as one line", kept => {
    localStorage.setItem(key, kept);

    expect(renderHook(() => useCardDensity()).result.current[0]).toBe("compact");
  });
});
