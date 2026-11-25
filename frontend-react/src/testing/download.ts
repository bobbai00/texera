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

import { vi } from "vitest";

/** A file the app saved: the name it gave it, and its contents. */
export interface SavedFile {
  fileName: string;
  blob: Blob;
}

/** Records the files the app saves, in order: jsdom can neither make a URL for a blob nor download it. */
export function recordDownloads(): SavedFile[] {
  const saved: SavedFile[] = [];
  const blobs = new Map<string, Blob>();
  URL.createObjectURL = (blob: Blob) => {
    const href = `blob:texera/${blobs.size}`;
    blobs.set(href, blob);
    return href;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ fileName: this.download, blob: blobs.get(this.href)! });
  });
  return saved;
}
