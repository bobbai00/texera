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

// Written out in full, so that the build finds each class.
const backgrounds = [
  "bg-presence-1",
  "bg-presence-2",
  "bg-presence-3",
  "bg-presence-4",
  "bg-presence-5",
  "bg-presence-6",
];
const texts = [
  "text-presence-1",
  "text-presence-2",
  "text-presence-3",
  "text-presence-4",
  "text-presence-5",
  "text-presence-6",
];

/** The classes that show something in the color of someone else in the room: as a background, or as text. */
export function presenceClassNames({ color }: { color: number }): { background: string; text: string } {
  return { background: backgrounds[color - 1], text: texts[color - 1] };
}
