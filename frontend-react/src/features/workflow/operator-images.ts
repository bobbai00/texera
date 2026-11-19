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

// Every operator type has a picture, named after the type. They are the ones the Angular app shows, read from its
// assets so that there is one copy of each in the repository.
const images = import.meta.glob<string>("../../../../frontend/src/assets/operator_images/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const byType = new Map(
  Object.entries(images).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url])
);

/** The picture of an operator type, or undefined for a type that has none. */
export function operatorImage(operatorType: string): string | undefined {
  return byType.get(operatorType);
}
