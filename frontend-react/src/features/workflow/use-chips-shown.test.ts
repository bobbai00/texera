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
import { useChipsShown } from "./use-chips-shown";

const key = "texera.workflowCanvas.chips";

describe("useChipsShown", () => {
  it("shows the chips around the cards until the viewer hides them, and keeps their choice", () => {
    const { result, unmount } = renderHook(() => useChipsShown());
    expect(result.current[0]).toBe(true);

    act(() => result.current[1](false));

    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(key)).toBe("false");
    unmount();
    expect(renderHook(() => useChipsShown()).result.current[0]).toBe(false);
  });

  it.each(['"hidden"', "0", "null", "{}", "not JSON"])("reads what it cannot use, %s, as shown", kept => {
    localStorage.setItem(key, kept);

    expect(renderHook(() => useChipsShown()).result.current[0]).toBe(true);
  });
});
