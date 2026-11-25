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

// The path by which a workflow names a version of a dataset or of a model, or a file in one, read as the server
// reads it (FileResolver.scala): /dataset/<owner's email>/<name>/<version>, or /model/..., then the path of the file
// in the version when it names one. A path without the prefix is a dataset's, as paths were written before models
// came. A path says nothing of whether what it names exists, or who may read it: that is the server's to say.

import type { ResourceKind } from "./resource";

/** A version of a dataset or of a model, and a file in it when the path names one. */
export interface ResourcePath {
  kind: Extract<ResourceKind, "dataset" | "model">;
  /** The email of the user who owns it. Not every one has an @: the first administrator's is "texera". */
  owner: string;
  name: string;
  /** The name of the version, such as "v1" or "v2 - by island". */
  version: string;
  /** The path of the file in the version, such as "islands/biscoe.csv". */
  file?: string;
}

/** The first segments that say which kind of resource a path names, written exactly so (ResourceType.scala). */
const prefixes: ResourcePath["kind"][] = ["dataset", "model"];

/** What a path names, or undefined for a value that the server does not read as a path. */
export function parseResourcePath(value: string): ResourcePath | undefined {
  const text = value.trim();
  // A value that starts with a URI's scheme, of two characters or more, names a file found already, as https:… and
  // dataset:///… do. A drive letter, as in C:/data.csv, is no scheme.
  if (/^[a-z][a-z\d+.-]+:/i.test(text)) return undefined;
  // The segments of the path, as a file system has them: repeated and trailing slashes make none.
  const segments = text.split("/").filter(segment => segment !== "");
  const prefix = prefixes.find(kind => kind === segments[0]);
  const [owner, name, version, ...file] = prefix ? segments.slice(1) : segments;
  if (version === undefined) return undefined;
  return { kind: prefix ?? "dataset", owner, name, version, ...(file.length > 0 && { file: file.join("/") }) };
}

/** The path of a version, or of a file in one, as stored paths are written now: with the prefix of its kind. */
export function resourcePath({ kind, owner, name, version, file }: ResourcePath): string {
  return ["", kind, owner, name, version, ...(file ? [file] : [])].join("/");
}
