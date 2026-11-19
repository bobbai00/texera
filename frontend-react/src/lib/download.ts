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

/**
 * Downloads a file from a presigned storage URL and saves it under fileName.
 *
 * The URL is on another origin (the S3 server), where a link's `download` name is ignored, so the
 * file is fetched and saved from memory. The request carries no Texera token: the URL grants access.
 */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const failure = `Could not download ${fileName}.`;
  const response = await fetch(url).catch(() => {
    throw new Error(failure);
  });
  if (!response.ok) throw new Error(failure);
  saveBlob(await response.blob(), fileName);
}

/** Saves text that the app made, such as a workflow as JSON, as a file of the user's. */
export function saveText(text: string, fileName: string, type = "application/json"): void {
  saveBlob(new Blob([text], { type }), fileName);
}

function saveBlob(blob: Blob, fileName: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.click();
  // Revoked after the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(href));
}
