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

import type { DatasetFile, FileNode } from "./api";

/** The server lists names in reverse order; people look for folders first, then names from A to Z. */
export function foldersFirstThenByName(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Every file of a version, in the order its tree shows them: each folder's files after its folders. */
export function filesInOrder(nodes: FileNode[]): DatasetFile[] {
  return nodes
    .toSorted(foldersFirstThenByName)
    .flatMap(node => (node.type === "directory" ? filesInOrder(node.children) : [node]));
}

/** A file's path within its version, as the address names it: "penguins.csv", or "2024/penguins.csv". */
export function pathInVersion(file: DatasetFile, root: string): string {
  return `${file.parentDir}/${file.name}`.slice(root.length + 1);
}

/** The file a version shows first: its README at the top, as a repository does, or else its first file. */
export function firstFileOf(nodes: FileNode[]): DatasetFile | undefined {
  const readme = nodes.find(node => node.type === "file" && /^readme(\.(md|markdown|txt))?$/i.test(node.name));
  return readme?.type === "file" ? readme : filesInOrder(nodes).at(0);
}
