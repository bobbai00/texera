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

import { useEffect, useRef, useState } from "react";

/**
 * A choice of the user's that this browser keeps for the next time, such as how they left a panel. It is read once,
 * when the component starts, through `read`, which turns whatever is kept, or nothing, into a value, and kept once
 * the user changes it: until then, a default that changes later reaches them. It is a convenience of one browser
 * only: one that keeps nothing, as a private window may, still has the value for as long as the page is open.
 */
export function useStoredState<T>(key: string, read: (stored: unknown) => T) {
  const [value, setValue] = useState(() => read(storedValue(key)));
  const kept = useRef(value);
  useEffect(() => {
    if (Object.is(value, kept.current)) return;
    kept.current = value;
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The value is still as the user made it; it is only not remembered.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

function storedValue(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
